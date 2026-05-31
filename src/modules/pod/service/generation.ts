import { Init, Inject, Provide } from '@midwayjs/core';
import { BaseService, CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as moment from 'moment';
import { v4 as uuidv4 } from 'uuid';
import { PodGenerationBatchEntity } from '../entity/batch';
import { PodGenerationItemEntity } from '../entity/item';
import { PodPromptService } from './prompt';
import { PodImageService } from './image';
import { PodDeepseekService } from './deepseek';
import { PodSettingService } from './setting';
import { PodMockupService } from './mockup';

/**
 * POD批量生成
 */
@Provide()
export class PodGenerationService extends BaseService {
  @InjectEntityModel(PodGenerationBatchEntity)
  batchEntity: Repository<PodGenerationBatchEntity>;

  @InjectEntityModel(PodGenerationItemEntity)
  itemEntity: Repository<PodGenerationItemEntity>;

  @Inject()
  podPromptService: PodPromptService;

  @Inject()
  podImageService: PodImageService;

  @Inject()
  podDeepseekService: PodDeepseekService;

  @Inject()
  podSettingService: PodSettingService;

  @Inject()
  podMockupService: PodMockupService;

  @Init()
  async init() {
    await super.init();
    // Cool 的基础 CRUD 仍然作用在“批次”表上，图片任务项单独走自定义接口。
    this.setEntity(this.batchEntity);
  }

  async delete(ids: any) {
    // 删除批次时同步清理图片任务项，避免产生游离记录。
    const idArr = Array.isArray(ids) ? ids : String(ids).split(',');
    await this.itemEntity.delete({ batchId: In(idArr.map(id => Number(id))) });
    return super.delete(ids);
  }

  async createBatch(params: any) {
    // 创建批次只负责生成并保存提示词，不立即生图；生图需要用户确认提示词后再触发。
    const topic = String(params.topic || '').trim();
    if (!topic) {
      throw new CoolCommException('请输入生成主题');
    }

    const count = this.clamp(Number(params.count || 10), 1, 100);
    const concurrency = this.clamp(Number(params.concurrency || 3), 1, 10);
    const retries = this.clamp(Number(params.retries ?? 1), 0, 5);
    // 读取后台“模块设置”，让接口地址、模型、尺寸、输出目录等参数可以动态调整。
    const settings = await this.podSettingService.getSettings();
    const timeoutMs = this.clamp(
      Number(params.timeoutMs || settings.generation.timeoutMs || 180000),
      30000,
      600000
    );
    const topicSlug = this.podPromptService.slugify(topic) || 'pod-topic';
    const date = moment().format('YYYY-MM-DD');
    const batchNo = this.createBatchNo(topicSlug);
    const outputDir = this.resolveOutputDir(
      date,
      topicSlug,
      settings.generation.outputDir
    );

    // 先落批次，DeepSeek 失败时也能保留失败状态和错误信息。
    const batch = await this.batchEntity.save({
      batchNo,
      topic,
      topicSlug,
      count,
      concurrency,
      retries,
      timeoutMs,
      status: 'prompt_generating',
      successCount: 0,
      failedCount: 0,
      promptCount: 0,
      approvedPromptCount: 0,
      outputDir,
      options: {
        provider: settings.generation.provider || 'mock',
      },
    });

    try {
      // 一次性让 DeepSeek 返回指定数量的差异化 Prompt，再拆成图片任务项。
      const prompts = await this.podDeepseekService.generate(topic, count);
      const used = new Set<string>();
      await this.itemEntity.save(
        prompts.map((item, index) => {
          const seoFileName = this.uniqueSeoFileName(item.seoFileName, used, index);
          return {
            itemNo: String(index + 1).padStart(3, '0'),
            batchId: batch.id,
            subTheme: item.subTheme,
            promptSource: 'deepseek',
            promptStatus: 'draft',
            prompt: item.prompt,
            seoFileName,
            seoTitle: item.seoTitle || '',
            tags: (item.tags || []).join(','),
            status: 'pending',
            attempts: 0,
          };
        })
      );

      await this.refreshBatchStats(batch.id);
      // 提示词生成完成后进入待确认状态，等待用户审核后再生图。
      await this.batchEntity.update(batch.id, { status: 'prompt_ready' });
      await this.writeArtifacts(batch.id);
      return this.infoWithItems(batch.id);
    } catch (err) {
      await this.batchEntity.update(batch.id, {
        status: 'failed',
        error: err.message,
      });
      throw err;
    }
  }

  async runBatch(id: number) {
    // 执行批次只处理“已确认 + 待生成”的任务项，不会重复生成已成功图片。
    const batch = await this.ensureBatch(id);
    const approvedCount = await this.itemEntity.countBy({
      batchId: id,
      promptStatus: 'approved',
    });
    if (!approvedCount) {
      throw new CoolCommException('请先确认至少一条提示词');
    }
    await this.batchEntity.update(id, { status: 'image_generating', error: null });
    const items = await this.itemEntity.find({
      where: { batchId: id, status: 'pending', promptStatus: 'approved' },
      order: { id: 'ASC' },
    });

    // 按批次配置的并发数执行，避免一次性打爆图片生成接口。
    await this.runPool(items, batch.concurrency, item =>
      this.runItem(item.id, batch.retries)
    );
    return this.finishBatch(id);
  }

  async retryFailed(id: number) {
    // 重试失败只重置失败项，仍然要求提示词已确认。
    const batch = await this.ensureBatch(id);
    await this.itemEntity.update(
      { batchId: id, status: 'failed', promptStatus: 'approved' },
      { status: 'pending', error: null }
    );
    await this.batchEntity.update(id, { status: 'image_generating', error: null });
    const items = await this.itemEntity.find({
      where: { batchId: id, status: 'pending', promptStatus: 'approved' },
      order: { id: 'ASC' },
    });

    await this.runPool(items, batch.concurrency, item =>
      this.runItem(item.id, batch.retries)
    );
    return this.finishBatch(id);
  }

  async retryItem(id: number) {
    // 单条重生成：用于用户对某张结果不满意时重新跑同一条 Prompt。
    const item = await this.itemEntity.findOneBy({ id });
    if (!item) {
      throw new CoolCommException('任务项不存在');
    }
    if (item.promptStatus !== 'approved') {
      throw new CoolCommException('请先确认该提示词');
    }
    const batch = await this.ensureBatch(item.batchId);
    await this.itemEntity.update(id, { status: 'pending', error: null });
    await this.runItem(id, batch.retries);
    return this.finishBatch(batch.id);
  }

  async retryItems(params: any) {
    // 批量重生成：只允许同一批次内的已确认任务项，便于复用该批次的并发和重试配置。
    const ids = Array.isArray(params.ids)
      ? params.ids.map(id => Number(id)).filter(Boolean)
      : [];
    if (!ids.length) {
      throw new CoolCommException('请选择需要重新生成的图片');
    }

    const items = await this.itemEntity.find({
      where: { id: In(ids) },
      order: { id: 'ASC' },
    });
    if (items.length !== ids.length) {
      throw new CoolCommException('部分任务项不存在');
    }

    const batchIds = new Set(items.map(item => item.batchId));
    if (batchIds.size > 1) {
      throw new CoolCommException('只能批量重新生成同一批次的图片');
    }
    if (items.some(item => item.promptStatus !== 'approved')) {
      throw new CoolCommException('只能重新生成已确认提示词的图片');
    }
    if (items.some(item => item.status === 'running')) {
      throw new CoolCommException('生成中的图片不能重复提交');
    }

    const batchId = items[0].batchId;
    const batch = await this.ensureBatch(batchId);
    await this.itemEntity.update({ id: In(ids) }, { status: 'pending', error: null });
    await this.batchEntity.update(batchId, {
      status: 'image_generating',
      error: null,
    });
    await this.runPool(items, batch.concurrency, item =>
      this.runItem(item.id, batch.retries)
    );
    return this.finishBatch(batchId);
  }

  async cutoutItem(id: number) {
    // 单图抠图：对已经生成成功的图片执行 ComfyUI 背景移除，并直接回写当前图片记录。
    const item = await this.itemEntity.findOneBy({ id });
    if (!item) {
      throw new CoolCommException('任务项不存在');
    }
    if (item.status === 'running') {
      throw new CoolCommException('生成中的图片暂时不能抠图');
    }
    if (item.status !== 'success' && !(item.status === 'failed' && item.imageUrl)) {
      throw new CoolCommException('请先生成图片后再抠图');
    }
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      throw new CoolCommException('当前图片文件不存在，请先重新生成');
    }

    const batch = await this.ensureBatch(item.batchId);
    const startedAt = Date.now();
    await this.itemEntity.update(id, {
      status: 'running',
      error: null,
    });

    try {
      const result = await this.podImageService.cutout({
        fileName: item.fileName,
        filePath: item.filePath,
        imageUrl: item.imageUrl,
      });
      const { postProcessError, ...imageResult } = result;
      let mockupResult = {};
      let error = postProcessError || null;
      try {
        mockupResult = await this.generateMockupResult(batch, imageResult);
      } catch (err) {
        error = `效果图生成失败：${err.message}`;
      }

      await this.itemEntity.update(id, {
        ...imageResult,
        ...mockupResult,
        status: 'success',
        error,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      // 抠图失败不代表原图生成失败；保留已有图片和重试入口，只记录本次抠图错误。
      await this.itemEntity.update(id, {
        status: item.imageUrl ? 'success' : 'failed',
        error: err.message,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    } finally {
      await this.refreshBatchStats(batch.id);
      await this.writeArtifacts(batch.id);
    }

    return this.finishBatch(batch.id);
  }

  async generateMockupItem(id: number) {
    // 单独生成 T 恤效果图：只读取当前印花图，不重新生图，也不重新抠图。
    const item = await this.itemEntity.findOneBy({ id });
    if (!item) {
      throw new CoolCommException('任务项不存在');
    }
    if (item.status === 'running') {
      throw new CoolCommException('生成中的图片暂时不能生成效果图');
    }
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      throw new CoolCommException('当前图片文件不存在，请先生成图片');
    }

    const batch = await this.ensureBatch(item.batchId);
    try {
      const mockupResult = await this.generateMockupResult(batch, {
        fileName: item.fileName,
        filePath: item.filePath,
        imageUrl: item.imageUrl,
      });
      await this.itemEntity.update(id, {
        ...mockupResult,
        error: null,
      });
      await this.writeArtifacts(batch.id);
      return this.itemEntity.findOneBy({ id });
    } catch (err) {
      await this.itemEntity.update(id, { error: err.message });
      throw err;
    }
  }

  async items(query: any) {
    // 图片管理和批次详情都复用这个任务项分页接口；不要走批次表的通用分页渲染。
    const page = this.clamp(Number(query.page || 1), 1, 100000);
    const size = this.clamp(Number(query.size || 20), 1, 100);
    const find = this.itemEntity.createQueryBuilder('a');
    if (query.batchId) {
      find.andWhere('a.batchId = :batchId', { batchId: Number(query.batchId) });
    }
    if (query.status) {
      find.andWhere('a.status = :status', { status: query.status });
    }
    if (query.promptStatus) {
      find.andWhere('a.promptStatus = :promptStatus', {
        promptStatus: query.promptStatus,
      });
    }
    if (query.keyWord) {
      find.andWhere(
        '(a.prompt like :keyWord or a.seoFileName like :keyWord or a.seoTitle like :keyWord)',
        { keyWord: `%${query.keyWord}%` }
      );
    }
    // 全局图片管理按创建时间倒序；批次详情保留任务创建顺序，方便按编号审核。
    if (query.order === 'latest' || !query.batchId) {
      find.orderBy('a.createTime', 'DESC').addOrderBy('a.id', 'DESC');
    } else {
      find.orderBy('a.id', 'ASC');
    }
    const [list, total] = await find
      .skip((page - 1) * size)
      .take(size)
      .getManyAndCount();
    return {
      list,
      pagination: {
        page,
        size,
        total,
      },
    };
  }

  async updatePrompt(params: any) {
    // 编辑 Prompt 后重新置为待确认，避免未审核的新内容直接进入生图流程。
    const item = await this.itemEntity.findOneBy({ id: Number(params.id) });
    if (!item) {
      throw new CoolCommException('任务项不存在');
    }
    if (item.status === 'running') {
      throw new CoolCommException('生成中的任务不能编辑');
    }

    await this.itemEntity.update(item.id, {
      prompt: String(params.prompt || '').trim(),
      seoFileName: this.podPromptService.slugify(params.seoFileName || item.seoFileName),
      seoTitle: params.seoTitle ? String(params.seoTitle).slice(0, 180) : item.seoTitle,
      tags: params.tags ? String(params.tags).slice(0, 500) : item.tags,
      promptStatus: 'draft',
    });
    await this.refreshBatchStats(item.batchId);
    await this.writeArtifacts(item.batchId);
    return this.itemEntity.findOneBy({ id: item.id });
  }

  async approvePrompts(params: any) {
    // 用户确认后，这些任务项才允许进入图片生成。
    const ids = Array.isArray(params.ids) ? params.ids.map(Number) : [];
    if (!ids.length) {
      throw new CoolCommException('请选择提示词');
    }
    await this.itemEntity.update({ id: In(ids) }, { promptStatus: 'approved' });
    const item = await this.itemEntity.findOneBy({ id: ids[0] });
    await this.refreshBatchStats(item.batchId);
    await this.batchEntity.update(item.batchId, { status: 'prompt_ready' });
    await this.writeArtifacts(item.batchId);
    return this.infoWithItems(item.batchId);
  }

  async rejectPrompts(params: any) {
    // 驳回只影响提示词状态，不删除记录，便于后续编辑或追溯。
    const ids = Array.isArray(params.ids) ? params.ids.map(Number) : [];
    if (!ids.length) {
      throw new CoolCommException('请选择提示词');
    }
    await this.itemEntity.update({ id: In(ids) }, { promptStatus: 'rejected' });
    const item = await this.itemEntity.findOneBy({ id: ids[0] });
    await this.refreshBatchStats(item.batchId);
    await this.writeArtifacts(item.batchId);
    return this.infoWithItems(item.batchId);
  }

  async infoWithItems(id: number) {
    const batch = await this.ensureBatch(id);
    const items = await this.itemEntity.find({
      where: { batchId: id },
      order: { id: 'ASC' },
    });
    return {
      ...batch,
      items,
    };
  }

  private async runItem(id: number, retries: number) {
    // 实际调用图片模型的最小执行单元，批量、单条、失败重试都会复用这里。
    const item = await this.itemEntity.findOneBy({ id });
    if (!item) {
      return;
    }
    if (item.promptStatus !== 'approved') {
      return;
    }
    const batch = await this.ensureBatch(item.batchId);
    const settings = await this.podSettingService.getSettings();
    const startedAt = Date.now();
    const attempts = item.attempts + 1;

    await this.itemEntity.update(id, {
      status: 'running',
      attempts,
      error: null,
    });

    try {
      const imageDir = path.join(batch.outputDir, 'images');
      const publicDir = `/generated/temu-tshirt/${moment(batch.createTime).format('YYYY-MM-DD')}/${batch.topicSlug}/images`;
      // 最终发给图片模型的 Prompt = 单条差异化 Prompt + 模块统一提示词。
      const finalPrompt = this.podSettingService.appendUnifiedPrompt(
        item.prompt,
        settings
      );
      console.info(
        [
          '[POD_IMAGE_PROMPT]',
          `batchNo=${batch.batchNo}`,
          `itemNo=${item.itemNo}`,
          `model=${settings.generation.model}`,
          `size=${settings.generation.size}`,
          `outputSize=${settings.generation.outputSize}`,
          'prompt:',
          finalPrompt,
          '[/POD_IMAGE_PROMPT]',
        ].join('\n')
      );
      const result = await this.podImageService.generate({
        prompt: finalPrompt,
        fileBaseName: this.getImageFileBaseName(item),
        outputDir: imageDir,
        publicDir,
        timeoutMs: batch.timeoutMs,
      });
      const { postProcessError, ...imageResult } = result;
      let mockupResult = {};
      let error = postProcessError || null;
      if (!postProcessError) {
        try {
          // 只有抠图成功后才自动合成效果图，避免把带背景的原图贴到 T 恤模板上。
          mockupResult = await this.generateMockupResult(batch, imageResult);
        } catch (err) {
          error = `效果图生成失败：${err.message}`;
        }
      }

      await this.itemEntity.update(id, {
        ...imageResult,
        ...mockupResult,
        status: 'success',
        error,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      // attempts 是本次已经尝试的次数；未超过重试上限时继续递归重跑当前任务。
      if (attempts <= retries) {
        await this.itemEntity.update(id, {
          status: 'pending',
          attempts,
          error: err.message,
          durationMs: Date.now() - startedAt,
        });
        return this.runItem(id, retries);
      }

      const hasExistingImage = Boolean(item.imageUrl && item.filePath);
      await this.itemEntity.update(id, {
        // 重生成失败时，如果原来已有图片，不把旧成果标成失败，避免列表出现“有图但失败”的误导状态。
        status: hasExistingImage ? 'success' : 'failed',
        attempts,
        error: hasExistingImage
          ? `重新生成失败，已保留原图片：${err.message}`
          : err.message,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      await this.refreshBatchStats(batch.id);
      await this.writeArtifacts(batch.id);
    }
  }

  private async finishBatch(id: number) {
    // 根据任务项最终统计回写批次状态，供列表页直接展示进度。
    const stats = await this.refreshBatchStats(id);
    const status =
      stats.failedCount === 0
        ? 'completed'
        : stats.successCount > 0
          ? 'partial_failed'
          : 'failed';
    await this.batchEntity.update(id, { status });
    await this.writeArtifacts(id);
    return this.infoWithItems(id);
  }

  private async refreshBatchStats(id: number) {
    // 批次统计全部由任务项实时汇总，避免前端根据列表自行推算。
    const [successCount, failedCount, promptCount, approvedPromptCount] =
      await Promise.all([
      this.itemEntity.countBy({ batchId: id, status: 'success' }),
      this.itemEntity.countBy({ batchId: id, status: 'failed' }),
      this.itemEntity.countBy({ batchId: id }),
      this.itemEntity.countBy({ batchId: id, promptStatus: 'approved' }),
    ]);
    await this.batchEntity.update(id, {
      successCount,
      failedCount,
      promptCount,
      approvedPromptCount,
    });
    return { successCount, failedCount, promptCount, approvedPromptCount };
  }

  private async writeArtifacts(batchId: number) {
    // 每次关键状态变化都写出 manifest 和 prompts.csv，方便离线查看和交付。
    const batch = await this.ensureBatch(batchId);
    const items = await this.itemEntity.find({
      where: { batchId },
      order: { id: 'ASC' },
    });
    await fs.promises.mkdir(path.join(batch.outputDir, 'images'), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(batch.outputDir, 'tshirt-effects'), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(batch.outputDir, 'manifest.json'),
      JSON.stringify({ ...batch, items }, null, 2)
    );
    await fs.promises.writeFile(
      path.join(batch.outputDir, 'prompts.csv'),
      this.toCsv(items)
    );
  }

  private toCsv(items: PodGenerationItemEntity[]) {
    const header = [
      'id',
      'status',
      'promptStatus',
      'seoFileName',
      'seoTitle',
      'tags',
      'fileName',
      'mockupImageUrl',
      'mockupFileName',
      'prompt',
      'error',
      'createdAt',
    ];
    const rows = items.map(item =>
      [
        item.itemNo,
        item.status,
        item.promptStatus,
        item.seoFileName,
        item.seoTitle || '',
        item.tags || '',
        item.fileName || '',
        item.mockupImageUrl || '',
        item.mockupFileName || '',
        item.prompt,
        item.error || '',
        item.createTime || '',
      ]
        .map(value => `"${String(value).replace(/"/g, '""')}"`)
        .join(',')
    );
    return [header.join(','), ...rows].join('\n');
  }

  private async runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>
  ) {
    // 简单并发池：多个 runner 共享 index，直到任务消费完。
    let index = 0;
    const runners = Array.from({
      length: Math.min(concurrency, items.length),
    }).map(async () => {
      while (index < items.length) {
        const item = items[index++];
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  private async generateMockupResult(
    batch: PodGenerationBatchEntity,
    image: { fileName: string; filePath: string; imageUrl: string }
  ) {
    return this.podMockupService.generate({
      printFileName: image.fileName,
      printFilePath: image.filePath,
      batchOutputDir: batch.outputDir,
      batchPublicDir: `/generated/temu-tshirt/${moment(batch.createTime).format('YYYY-MM-DD')}/${batch.topicSlug}`,
    });
  }

  private async ensureBatch(id: number) {
    const batch = await this.batchEntity.findOneBy({ id });
    if (!batch) {
      throw new CoolCommException('批次不存在');
    }
    return batch;
  }

  private uniqueSeoFileName(value: string, used: Set<string>, index: number) {
    // 同一批次内文件名必须唯一，否则后生成的图片会覆盖前一张。
    const base = this.podPromptService.slugify(value || `pod-tshirt-print-${index + 1}`);
    let name = base;
    let offset = 1;
    while (used.has(name)) {
      name = `${base}-${offset++}`;
    }
    used.add(name);
    return name;
  }

  private getImageFileBaseName(item: PodGenerationItemEntity) {
    // 实际落盘文件名优先使用标题，并尽量保留标题原有大小写和空格。
    const titleBase = this.normalizeImageFileBaseName(item.seoTitle || '');
    return titleBase || item.seoFileName;
  }

  private normalizeImageFileBaseName(value: string) {
    // 只清理文件系统不安全字符，保留大小写、空格和正常连字符，方便直接按标题识别图片。
    return String(value || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 180);
  }

  private createBatchNo(topicSlug: string) {
    // batchNo 数据库字段长度为 80，长英文主题生成的 slug 需要单独截断。
    const prefix = moment().format('YYYYMMDD');
    const suffix = uuidv4().slice(0, 4);
    const maxSlugLength = 80 - prefix.length - suffix.length - 2;
    const slug =
      String(topicSlug || 'pod-topic')
        .slice(0, maxSlugLength)
        .replace(/-+$/g, '') || 'pod-topic';
    return `${prefix}-${slug}-${suffix}`;
  }

  private resolveOutputDir(date: string, topicSlug: string, outputDir: string) {
    // 相对路径按服务端进程目录解析；默认会落到项目根目录的 generated 下。
    outputDir = outputDir || '../generated/temu-tshirt';
    const root = path.isAbsolute(outputDir)
      ? outputDir
      : path.resolve(process.cwd(), outputDir);
    return path.join(root, date, topicSlug);
  }

  private clamp(value: number, min: number, max: number) {
    if (Number.isNaN(value)) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }
}
