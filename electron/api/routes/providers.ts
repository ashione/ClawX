import type { IncomingMessage, ServerResponse } from 'http';
import {
  deleteApiKey,
  deleteProvider,
  getAllProvidersWithKeyInfo,
  getApiKey,
  getDefaultProvider,
  getProvider,
  hasApiKey,
  saveProvider,
  setDefaultProvider,
  storeApiKey,
  type ProviderConfig,
} from '../../utils/secure-storage';
import {
  getProviderConfig,
  getProviderDefaultModel,
} from '../../utils/provider-registry';
import {
  removeProviderFromOpenClaw,
  saveProviderKeyToOpenClaw,
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw,
  updateAgentModelProvider,
} from '../../utils/openclaw-auth';
import { deviceOAuthManager, type OAuthProviderType } from '../../utils/device-oauth';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { proxyAwareFetch } from '../../utils/proxy-fetch';

function getOpenClawProviderKey(type: string, providerId: string): string {
  if (type === 'custom' || type === 'ollama') {
    const suffix = providerId.replace(/-/g, '').slice(0, 8);
    return `${type}-${suffix}`;
  }
  if (type === 'minimax-portal-cn') {
    return 'minimax-portal';
  }
  return type;
}

function getProviderModelRef(config: ProviderConfig): string | undefined {
  const providerKey = getOpenClawProviderKey(config.type, config.id);
  if (config.model) {
    return config.model.startsWith(`${providerKey}/`)
      ? config.model
      : `${providerKey}/${config.model}`;
  }
  return getProviderDefaultModel(config.type);
}

async function getProviderFallbackModelRefs(config: ProviderConfig): Promise<string[]> {
  const allProviders = await getAllProvidersWithKeyInfo();
  const providerMap = new Map(allProviders.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const results: string[] = [];
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  for (const fallbackModel of config.fallbackModels ?? []) {
    const normalizedModel = fallbackModel.trim();
    if (!normalizedModel) continue;
    const modelRef = normalizedModel.startsWith(`${providerKey}/`)
      ? normalizedModel
      : `${providerKey}/${normalizedModel}`;
    if (seen.has(modelRef)) continue;
    seen.add(modelRef);
    results.push(modelRef);
  }

  for (const fallbackId of config.fallbackProviderIds ?? []) {
    if (!fallbackId || fallbackId === config.id) continue;
    const fallbackProvider = providerMap.get(fallbackId);
    if (!fallbackProvider) continue;
    const modelRef = getProviderModelRef(fallbackProvider);
    if (!modelRef || seen.has(modelRef)) continue;
    seen.add(modelRef);
    results.push(modelRef);
  }

  return results;
}

type ValidationProfile = 'openai-compatible' | 'google-query-key' | 'anthropic-header' | 'openrouter' | 'none';

function getValidationProfile(providerType: string): ValidationProfile {
  switch (providerType) {
    case 'anthropic':
      return 'anthropic-header';
    case 'google':
      return 'google-query-key';
    case 'openrouter':
      return 'openrouter';
    case 'ollama':
      return 'none';
    default:
      return 'openai-compatible';
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function classifyAuthResponse(status: number, data: unknown): { valid: boolean; error?: string } {
  if (status >= 200 && status < 300) return { valid: true };
  if (status === 429) return { valid: true };
  if (status === 401 || status === 403) return { valid: false, error: 'Invalid API key' };
  const obj = data as { error?: { message?: string }; message?: string } | null;
  return { valid: false, error: obj?.error?.message || obj?.message || `API error: ${status}` };
}

async function performProviderValidationRequest(
  url: string,
  headers: Record<string, string>,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await proxyAwareFetch(url, { headers });
    const data = await response.json().catch(() => ({}));
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return { valid: false, error: `Connection error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function performChatCompletionsProbe(
  url: string,
  headers: Record<string, string>,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await proxyAwareFetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'validation-probe',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API key' };
    }
    if ((response.status >= 200 && response.status < 300) || response.status === 400 || response.status === 429) {
      return { valid: true };
    }
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return { valid: false, error: `Connection error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function validateApiKeyWithProvider(
  providerType: string,
  apiKey: string,
  options?: { baseUrl?: string },
): Promise<{ valid: boolean; error?: string }> {
  const profile = getValidationProfile(providerType);
  if (profile === 'none') return { valid: true };
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) return { valid: false, error: 'API key is required' };

  switch (profile) {
    case 'openai-compatible': {
      const trimmedBaseUrl = options?.baseUrl?.trim();
      if (!trimmedBaseUrl) {
        return { valid: false, error: `Base URL is required for provider "${providerType}" validation` };
      }
      const headers = { Authorization: `Bearer ${trimmedKey}` };
      const modelsUrl = `${normalizeBaseUrl(trimmedBaseUrl)}/models?limit=1`;
      const modelsResult = await performProviderValidationRequest(modelsUrl, headers);
      if (modelsResult.error?.includes('API error: 404')) {
        return performChatCompletionsProbe(`${normalizeBaseUrl(trimmedBaseUrl)}/chat/completions`, headers);
      }
      return modelsResult;
    }
    case 'google-query-key': {
      const base = normalizeBaseUrl(options?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
      return performProviderValidationRequest(`${base}/models?pageSize=1&key=${encodeURIComponent(trimmedKey)}`, {});
    }
    case 'anthropic-header': {
      const base = normalizeBaseUrl(options?.baseUrl || 'https://api.anthropic.com/v1');
      return performProviderValidationRequest(`${base}/models?limit=1`, {
        'x-api-key': trimmedKey,
        'anthropic-version': '2023-06-01',
      });
    }
    case 'openrouter':
      return performProviderValidationRequest('https://openrouter.ai/api/v1/auth/key', {
        Authorization: `Bearer ${trimmedKey}`,
      });
    default:
      return { valid: false, error: `Unsupported provider validation profile: ${providerType}` };
  }
}

export async function handleProviderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/providers' && req.method === 'GET') {
    sendJson(res, 200, await getAllProvidersWithKeyInfo());
    return true;
  }

  if (url.pathname === '/api/providers/default' && req.method === 'GET') {
    sendJson(res, 200, { providerId: await getDefaultProvider() ?? null });
    return true;
  }

  if (url.pathname === '/api/providers/default' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{ providerId: string }>(req);
      await setDefaultProvider(body.providerId);
      const provider = await getProvider(body.providerId);
      if (provider) {
        const ock = getOpenClawProviderKey(provider.type, body.providerId);
        const providerKey = await getApiKey(body.providerId);
        const fallbackModels = await getProviderFallbackModelRefs(provider);
        const oauthTypes = ['qwen-portal', 'minimax-portal', 'minimax-portal-cn'];
        const isOAuthProvider = oauthTypes.includes(provider.type) && !providerKey;
        if (!isOAuthProvider) {
          const modelOverride = provider.model
            ? (provider.model.startsWith(`${ock}/`) ? provider.model : `${ock}/${provider.model}`)
            : undefined;
          if (provider.type === 'custom' || provider.type === 'ollama') {
            await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
              baseUrl: provider.baseUrl,
              api: 'openai-completions',
            }, fallbackModels);
          } else {
            await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
          }
          if (providerKey) {
            await saveProviderKeyToOpenClaw(ock, providerKey);
          }
        } else {
          const defaultBaseUrl = provider.type === 'minimax-portal'
            ? 'https://api.minimax.io/anthropic'
            : (provider.type === 'minimax-portal-cn' ? 'https://api.minimaxi.com/anthropic' : 'https://portal.qwen.ai/v1');
          let baseUrl = provider.baseUrl || defaultBaseUrl;
          if ((provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn') && baseUrl) {
            baseUrl = baseUrl.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
          }
          const targetProviderKey = (provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn')
            ? 'minimax-portal'
            : provider.type;
          await setOpenClawDefaultModelWithOverride(targetProviderKey, getProviderModelRef(provider), {
            baseUrl,
            api: targetProviderKey === 'minimax-portal' ? 'anthropic-messages' : 'openai-completions',
            authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
            apiKeyEnv: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
          }, fallbackModels);
        }
        if (ctx.gatewayManager.getStatus().state !== 'stopped') {
          ctx.gatewayManager.debouncedRestart();
        }
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/providers/validate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ providerId: string; apiKey: string; options?: { baseUrl?: string } }>(req);
      const provider = await getProvider(body.providerId);
      const providerType = provider?.type || body.providerId;
      const registryBaseUrl = getProviderConfig(providerType)?.baseUrl;
      const resolvedBaseUrl = body.options?.baseUrl || provider?.baseUrl || registryBaseUrl;
      sendJson(res, 200, await validateApiKeyWithProvider(providerType, body.apiKey, { baseUrl: resolvedBaseUrl }));
    } catch (error) {
      sendJson(res, 500, { valid: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/providers/oauth/start' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ provider: OAuthProviderType; region?: 'global' | 'cn' }>(req);
      await deviceOAuthManager.startFlow(body.provider, body.region);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/providers/oauth/cancel' && req.method === 'POST') {
    try {
      await deviceOAuthManager.stopFlow();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/providers' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ config: ProviderConfig; apiKey?: string }>(req);
      const config = body.config;
      await saveProvider(config);
      const ock = getOpenClawProviderKey(config.type, config.id);
      if (body.apiKey !== undefined) {
        const trimmedKey = body.apiKey.trim();
        if (trimmedKey) {
          await storeApiKey(config.id, trimmedKey);
          await saveProviderKeyToOpenClaw(ock, trimmedKey);
        }
      }
      const meta = getProviderConfig(config.type);
      const api = config.type === 'custom' || config.type === 'ollama' ? 'openai-completions' : meta?.api;
      if (api) {
        await syncProviderConfigToOpenClaw(ock, config.model, {
          baseUrl: config.baseUrl || meta?.baseUrl,
          api,
          apiKeyEnv: meta?.apiKeyEnv,
          headers: meta?.headers,
        });
        if (config.type === 'custom' || config.type === 'ollama') {
          const resolvedKey = body.apiKey !== undefined ? (body.apiKey.trim() || null) : await getApiKey(config.id);
          if (resolvedKey && config.baseUrl) {
            const modelId = config.model;
            await updateAgentModelProvider(ock, {
              baseUrl: config.baseUrl,
              api: 'openai-completions',
              models: modelId ? [{ id: modelId, name: modelId }] : [],
              apiKey: resolvedKey,
            });
          }
        }
        ctx.gatewayManager.debouncedRestart();
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/providers/') && req.method === 'GET') {
    const providerId = decodeURIComponent(url.pathname.slice('/api/providers/'.length));
    if (providerId.endsWith('/api-key')) {
      const actualId = providerId.slice(0, -('/api-key'.length));
      sendJson(res, 200, { apiKey: await getApiKey(actualId) });
      return true;
    }
    if (providerId.endsWith('/has-api-key')) {
      const actualId = providerId.slice(0, -('/has-api-key'.length));
      sendJson(res, 200, { hasKey: await hasApiKey(actualId) });
      return true;
    }
    sendJson(res, 200, await getProvider(providerId));
    return true;
  }

  if (url.pathname.startsWith('/api/providers/') && req.method === 'PUT') {
    const providerId = decodeURIComponent(url.pathname.slice('/api/providers/'.length));
    try {
      const body = await parseJsonBody<{ updates: Partial<ProviderConfig>; apiKey?: string }>(req);
      const existing = await getProvider(providerId);
      if (!existing) {
        sendJson(res, 404, { success: false, error: 'Provider not found' });
        return true;
      }
      const nextConfig: ProviderConfig = { ...existing, ...body.updates, updatedAt: new Date().toISOString() };
      const ock = getOpenClawProviderKey(nextConfig.type, providerId);
      await saveProvider(nextConfig);
      if (body.apiKey !== undefined) {
        const trimmedKey = body.apiKey.trim();
        if (trimmedKey) {
          await storeApiKey(providerId, trimmedKey);
          await saveProviderKeyToOpenClaw(ock, trimmedKey);
        } else {
          await deleteApiKey(providerId);
          await removeProviderFromOpenClaw(ock);
        }
      }
      const fallbackModels = await getProviderFallbackModelRefs(nextConfig);
      const meta = getProviderConfig(nextConfig.type);
      const api = nextConfig.type === 'custom' || nextConfig.type === 'ollama' ? 'openai-completions' : meta?.api;
      if (api) {
        await syncProviderConfigToOpenClaw(ock, nextConfig.model, {
          baseUrl: nextConfig.baseUrl || meta?.baseUrl,
          api,
          apiKeyEnv: meta?.apiKeyEnv,
          headers: meta?.headers,
        });
        const defaultProviderId = await getDefaultProvider();
        if (defaultProviderId === providerId) {
          const modelOverride = nextConfig.model ? `${ock}/${nextConfig.model}` : undefined;
          if (nextConfig.type !== 'custom' && nextConfig.type !== 'ollama') {
            await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
          } else {
            await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
              baseUrl: nextConfig.baseUrl,
              api: 'openai-completions',
            }, fallbackModels);
          }
        }
        ctx.gatewayManager.debouncedRestart();
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/providers/') && req.method === 'DELETE') {
    const providerId = decodeURIComponent(url.pathname.slice('/api/providers/'.length));
    try {
      const existing = await getProvider(providerId);
      if (url.searchParams.get('apiKeyOnly') === '1') {
        await deleteApiKey(providerId);
        if (existing?.type) {
          await removeProviderFromOpenClaw(getOpenClawProviderKey(existing.type, providerId));
        }
        sendJson(res, 200, { success: true });
        return true;
      }
      await deleteProvider(providerId);
      if (existing?.type) {
        await removeProviderFromOpenClaw(getOpenClawProviderKey(existing.type, providerId));
        ctx.gatewayManager.debouncedRestart();
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
