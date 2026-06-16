import { Config, Provide } from '@midwayjs/core';
import { BaseService, CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Not, Repository } from 'typeorm';
import { PodProviderConfigEntity } from '../entity/provider';

export type PodProviderType = 'image' | 'prompt';

export interface PodProviderRuntimeConfig {
  id: number;
  name: string;
  code: string;
  type: PodProviderType;
  enabled: boolean;
  protocol: string;
  endpoint: string;
  apiKey: string;
  model: string;
  concurrency: number;
}

/**
 * POD供应商配置
 */
@Provide()
export class PodProviderConfigService extends BaseService {
  @InjectEntityModel(PodProviderConfigEntity)
  providerEntity: Repository<PodProviderConfigEntity>;

  @Config('module.pod.generation')
  generationConfig;

  @Config('module.pod.prompt')
  promptConfig;

  async add(param: any) {
    const data = await this.normalizeInput(param);
    await this.ensureCodeUnique(data.type, data.code);
    const saved = await this.providerEntity.save(data);
    return saved;
  }

  async update(param: any) {
    const old = await this.providerEntity.findOneBy({ id: Number(param.id) });
    if (!old) {
      throw new CoolCommException('供应商不存在');
    }
    const data = await this.normalizeInput({ ...old, ...param }, old);
    await this.ensureCodeUnique(data.type, data.code, old.id);
    if (this.shouldKeepOldApiKey(param.apiKey)) {
      data.apiKey = old.apiKey;
    }
    await this.providerEntity.save(data);
    return;
  }

  async info(id: any) {
    return this.providerEntity.findOneBy({ id: Number(id) });
  }

  async page(query: any, option: any, connectionName?: any) {
    return super.page(query, option, connectionName);
  }

  async list(query: any, option: any, connectionName?: any) {
    return super.list(query, option, connectionName);
  }

  async options(type?: PodProviderType) {
    await this.ensureDefaultProviders();
    const query = this.providerEntity
      .createQueryBuilder('a')
      .select(['a.id', 'a.name', 'a.code', 'a.type', 'a.protocol', 'a.enabled'])
      .where('a.enabled = :enabled', { enabled: true });

    if (type) {
      query.andWhere('a.type = :type', { type });
    }

    return query
      .orderBy('a.orderNum', 'ASC')
      .addOrderBy('a.id', 'ASC')
      .getMany();
  }

  async ensureDefaultProviders() {
    const imageProvider = await this.ensureProvider('image', {
      name: 'RightCodes 图片生成',
      code: this.generationConfig?.provider || 'rightcodes',
      protocol: this.generationConfig?.protocol || 'openai-images',
      endpoint:
        this.generationConfig?.endpoint ||
        'https://www.right.codes/draw/v1/images/generations',
      apiKey: this.generationConfig?.apiKey || '',
      model: this.generationConfig?.model || 'gpt-image-2',
      concurrency: Number(this.generationConfig?.concurrency || 3),
      orderNum: 1,
    });

    const promptProvider = await this.ensureProvider('prompt', {
      name: 'DeepSeek 提示词生成',
      code: this.promptConfig?.provider || 'deepseek',
      protocol: this.promptConfig?.protocol || 'openai-chat',
      endpoint:
        this.promptConfig?.endpoint ||
        'https://api.deepseek.com/chat/completions',
      apiKey: this.promptConfig?.apiKey || '',
      model: this.promptConfig?.model || 'deepseek-v4-pro',
      concurrency: 1,
      orderNum: 1,
    });

    return { imageProvider, promptProvider };
  }

  async resolveForSettings(
    type: PodProviderType,
    providerId: any,
    legacyConfig: any = {}
  ) {
    if (providerId) {
      const provider = await this.providerEntity.findOneBy({
        id: Number(providerId),
        type,
      });
      if (provider) {
        return this.toRuntime(provider);
      }
    }

    const code = String(legacyConfig?.provider || '').trim();
    if (code) {
      const provider = await this.ensureProvider(type, legacyConfig, true);
      return this.toRuntime(provider);
    }

    const defaults = await this.ensureDefaultProviders();
    return this.toRuntime(
      type === 'image' ? defaults.imageProvider : defaults.promptProvider
    );
  }

  async requireEnabled(id: any, type: PodProviderType) {
    const provider = await this.providerEntity.findOneBy({
      id: Number(id),
      type,
      enabled: true,
    });
    if (!provider) {
      throw new CoolCommException(
        type === 'image'
          ? '请选择已启用的图片生成供应商'
          : '请选择已启用的提示词生成供应商'
      );
    }
    return this.toRuntime(provider);
  }

  toRuntime(provider: PodProviderConfigEntity): PodProviderRuntimeConfig {
    return {
      id: provider.id,
      name: provider.name,
      code: provider.code,
      type: provider.type as PodProviderType,
      enabled: provider.enabled,
      protocol: provider.protocol,
      endpoint: provider.endpoint || '',
      apiKey: provider.apiKey || '',
      model: provider.model || '',
      concurrency: this.numInRange(provider.concurrency, 3, 1, 100),
    };
  }

  private async ensureProvider(
    type: PodProviderType,
    input: any,
    updateExisting = false
  ) {
    const data = await this.normalizeInput({ ...input, type });
    const exists = await this.providerEntity.findOneBy({
      type: data.type,
      code: data.code,
    });
    if (exists) {
      if (updateExisting) {
        const merged = await this.normalizeInput(
          { ...exists, ...input, type, id: exists.id },
          exists
        );
        if (this.shouldKeepOldApiKey(input.apiKey)) {
          merged.apiKey = exists.apiKey;
        }
        await this.providerEntity.save(merged);
        return this.providerEntity.findOneBy({ id: exists.id });
      }
      return exists;
    }
    return this.providerEntity.save(data);
  }

  private async normalizeInput(input: any, old?: PodProviderConfigEntity) {
    const type = input.type === 'prompt' ? 'prompt' : 'image';
    const code = this.code(input.code || input.provider || old?.code);
    if (!code) {
      throw new CoolCommException('请填写供应商标识');
    }

    const protocol = this.normalizeProtocol(
      type,
      input.protocol || old?.protocol
    );

    return {
      id: input.id ? Number(input.id) : undefined,
      name: this.str(input.name || old?.name, code),
      code,
      type,
      enabled:
        typeof input.enabled === 'boolean'
          ? input.enabled
          : input.enabled === undefined
          ? old?.enabled ?? true
          : Boolean(input.enabled),
      protocol,
      endpoint: this.str(input.endpoint ?? old?.endpoint, ''),
      apiKey: this.str(input.apiKey ?? old?.apiKey, ''),
      model: this.str(input.model ?? old?.model, ''),
      concurrency: this.numInRange(
        input.concurrency,
        old?.concurrency || 3,
        1,
        100
      ),
      orderNum: this.numInRange(input.orderNum, old?.orderNum || 0, 0, 999999),
      remark: this.str(input.remark ?? old?.remark, ''),
    };
  }

  private shouldKeepOldApiKey(value: any) {
    const text = String(value || '').trim();
    return !text || /^\*+$/.test(text);
  }

  private async ensureCodeUnique(type: string, code: string, id?: number) {
    const where: any = { type, code };
    if (id) {
      where.id = Not(id);
    }
    const exists = await this.providerEntity.findOneBy(where);
    if (exists) {
      throw new CoolCommException('同类型下已存在相同供应商标识');
    }
  }

  private normalizeProtocol(type: PodProviderType, value: any) {
    const protocol = String(value || '').trim();
    const allowed =
      type === 'image'
        ? ['openai-images', 'mock']
        : ['openai-chat', 'anthropic-messages'];
    return allowed.includes(protocol) ? protocol : allowed[0];
  }

  private code(value: any) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private str(value: any, fallback: string) {
    const text = String(value ?? '').trim();
    return text || fallback;
  }

  private numInRange(value: any, fallback: number, min: number, max: number) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(num)));
  }
}
