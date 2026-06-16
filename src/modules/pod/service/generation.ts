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
import { PodPromptModelService } from './prompt-model';
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
  podPromptModelService: PodPromptModelService;

  @Inject()
  podSettingService: PodSettingService;

  @Inject()
  podMockupService: PodMockupService;

  private activeImageTasks = 0;
  private imageWaitQueue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private artifactTimers = new Map<number, NodeJS.Timeout>();
  private runningBatchIds = new Set<number>();

  @Init()
  async init() {
    await super.init();
    // Cool 的基础 CRUD 仍然作用在“批次”表上，图片任务项单独走自定义接口。
    this.setEntity(this.batchEntity);
  }

  async delete(ids: any) {
    // 删除批次和图片任务项必须在同一事务内完成，避免中间失败留下半删除状态。
    const idArr = (Array.isArray(ids) ? ids : String(ids).split(','))
      .map(id => Number(id))
      .filter(Boolean);
    if (!idArr.length) {
      return;
    }

    await this.batchEntity.manager.transaction(async manager => {
      await manager.delete(PodGenerationItemEntity, { batchId: In(idArr) });
      await manager.delete(PodGenerationBatchEntity, { id: In(idArr) });
    });
    return;
  }

  async createBatch(params: any) {
    // 创建批次先生成并保存提示词；可按前端开关决定是否自动审批并直接进入生图。
    const topic = String(params.topic || '').trim();
    if (!topic) {
      throw new CoolCommException('请输入生成主题');
    }

    // 读取后台“模块设置”，让接口地址、模型、尺寸、输出目录等参数可以动态调整。
    const settings = await this.podSettingService.getSettings();
    const count = this.clamp(Number(params.count || 10), 1, 100);
    const providerConcurrency = Number(settings.generation.concurrency || 0);
    const rawConcurrency =
      params.concurrency === undefined ||
      params.concurrency === null ||
      params.concurrency === ''
        ? providerConcurrency || count
        : Number(params.concurrency);
    const concurrency = this.clamp(Number(rawConcurrency || count), 1, 100);
    const retries = this.clamp(Number(params.retries ?? 1), 0, 5);
    const autoRun = params.autoRun !== false;
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

    // 先落批次，提示词模型失败时也能保留失败状态和错误信息。
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
        providerId: settings.generation.providerId,
        provider: settings.generation.provider || 'mock',
        providerName: settings.generation.providerName,
      },
    });

    try {
      // 一次性让提示词模型返回指定数量的差异化 Prompt，再拆成图片任务项。
      const prompts = await this.podPromptModelService.generate(topic, count);
      const promptSource = this.podPromptModelService.getPromptSource(settings);
      const used = new Set<string>();
      await this.itemEntity.save(
        prompts.map((item, index) => {
          const seoFileName = this.uniqueSeoFileName(
            item.seoFileName,
            used,
            index
          );
          return {
            itemNo: String(index + 1).padStart(3, '0'),
            batchId: batch.id,
            subTheme: item.subTheme,
            promptSource,
            promptStatus: autoRun ? 'approved' : 'draft',
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
      if (autoRun) {
        // 自动生图不阻塞创建接口：先返回批次，再由后台继续消化图片任务。
        await this.batchEntity.update(batch.id, { status: 'image_generating' });
        await this.writeArtifacts(batch.id);
        this.runBatchInBackground(batch.id);
        return this.infoWithItems(batch.id);
      }

      // 关闭自动生图时，保持原有人工审批流程。
      await this.batchEntity.update(batch.id, { status: 'prompt_ready' });
      await this.writeArtifacts(batch.id);
      return this.infoWithItems(batch.id);
    } catch (err) {
      await this.batchEntity.update(batch.id, {
        status: 'failed',
        error: this.formatDbError(err),
      });
      throw err;
    }
  }

  async createBatches(params: any = {}) {
    // Excel 导入入口：每一行代表一个独立批次，复用单批次创建和自动生图流程。
    let rows = [];
    if (Array.isArray(params.rows)) {
      rows = params.rows;
    } else if (Array.isArray(params.list)) {
      rows = params.list;
    }
    if (!rows.length) {
      throw new CoolCommException('请上传至少一条批次数据');
    }

    const results = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] || {};
      const topic = this.pickText(row, ['topic', '主题', '生成主题', '题目']);
      const count = this.pickNumber(row, ['count', '数量', '张数', '生成数量']);
      const concurrency = this.pickNumber(row, [
        'concurrency',
        '并发',
        '并发数',
      ]);
      const retries = this.pickNumber(row, [
        'retries',
        '失败重试',
        '重试',
        '重试次数',
      ]);
      const rowNo = index + 2;

      if (!topic) {
        results.push({
          rowNo,
          status: 'failed',
          error: '主题不能为空',
        });
        continue;
      }
      if (!count || count < 1) {
        results.push({
          rowNo,
          topic,
          status: 'failed',
          error: '数量必须大于 0',
        });
        continue;
      }

      try {
        const batch = await this.createBatch({
          topic,
          count,
          concurrency: concurrency || params.concurrency,
          retries: retries ?? params.retries,
          timeoutMs: params.timeoutMs,
          autoRun: params.autoRun !== false,
        });
        results.push({
          rowNo,
          topic,
          count,
          status: 'success',
          batchId: batch.id,
          batchNo: batch.batchNo,
        });
      } catch (err) {
        results.push({
          rowNo,
          topic,
          count,
          status: 'failed',
          error: this.formatDbError(err),
        });
      }
    }

    const success = results.filter(item => item.status === 'success').length;
    const failed = results.length - success;
    return {
      total: results.length,
      success,
      failed,
      results,
    };
  }

  async exportBatches(params: any = {}) {
    // 导出数据按批次创建时间筛选，主表返回批次，附表返回批次下的标题和 Prompt。
    const find = this.batchEntity.createQueryBuilder('a');
    const createTimeStart = this.normalizeDateTime(params.createTimeStart);
    const createTimeEnd = this.normalizeDateTime(params.createTimeEnd);
    if (createTimeStart) {
      find.andWhere('a.createTime >= :createTimeStart', { createTimeStart });
    }
    if (createTimeEnd) {
      find.andWhere('a.createTime <= :createTimeEnd', { createTimeEnd });
    }
    const batches = await find
      .orderBy('a.createTime', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .getMany();
    const batchIds = batches.map(item => item.id);
    const items = batchIds.length
      ? await this.itemEntity.find({
          where: { batchId: In(batchIds) },
          order: { batchId: 'ASC', id: 'ASC' },
        })
      : [];

    return {
      batches,
      items,
    };
  }

  async runBatch(id: number) {
    // 执行批次只处理“已确认 + 待生成”的任务项，不会重复生成已成功图片。
    if (!this.acquireBatchLock(id)) {
      throw new CoolCommException('当前批次正在生成中，请勿重复执行');
    }

    try {
      const batch = await this.ensureBatch(id);
      const approvedCount = await this.itemEntity.countBy({
        batchId: id,
        promptStatus: 'approved',
      });
      if (!approvedCount) {
        throw new CoolCommException('请先确认至少一条提示词');
      }
      await this.batchEntity.update(id, {
        status: 'image_generating',
        error: null,
      });
      const items = await this.itemEntity.find({
        where: { batchId: id, status: 'pending', promptStatus: 'approved' },
        order: { id: 'ASC' },
      });

      // 按批次配置的并发数执行；失败重试会回到队列尾部，避免长时间占住同一 worker。
      await this.runItemsWithRetries(items, batch.concurrency, batch.retries);
      return this.finishBatch(id);
    } finally {
      this.releaseBatchLock(id);
    }
  }

  private runBatchInBackground(id: number) {
    setImmediate(() => {
      if (this.runningBatchIds.has(id)) {
        console.warn(`[POD_BATCH_SKIP] batch=${id} reason=already-running`);
        return;
      }
      this.runBatch(id).catch(async err => {
        await this.batchEntity.update(id, {
          status: 'failed',
          error: this.formatDbError(err),
        });
      });
    });
  }

  async retryFailed(id: number) {
    // 重试失败只重置失败项，仍然要求提示词已确认。
    if (!this.acquireBatchLock(id)) {
      throw new CoolCommException('当前批次正在生成中，请勿重复执行');
    }

    try {
      const batch = await this.ensureBatch(id);
      if ((await this.countActiveItems(id)) > 0) {
        throw new CoolCommException('当前批次正在生成中，请稍后再重试失败项');
      }

      await this.itemEntity.update(
        { batchId: id, status: 'failed', promptStatus: 'approved' },
        { status: 'pending', error: null }
      );
      await this.batchEntity.update(id, {
        status: 'image_generating',
        error: null,
      });
      const items = await this.itemEntity.find({
        where: { batchId: id, status: 'pending', promptStatus: 'approved' },
        order: { id: 'ASC' },
      });

      await this.runItemsWithRetries(items, batch.concurrency, batch.retries);
      return this.finishBatch(id);
    } finally {
      this.releaseBatchLock(id);
    }
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
    if (item.status === 'running' || item.status === 'cutout_running') {
      throw new CoolCommException('处理中的图片不能重复提交');
    }
    const batch = await this.ensureBatch(item.batchId);
    await this.ensureBatchNotProcessing(batch.id);
    await this.itemEntity.update(id, { status: 'pending', error: null });
    const pendingItem = await this.itemEntity.findOneBy({ id });
    await this.runItemsWithRetries(
      pendingItem ? [pendingItem] : [],
      1,
      batch.retries
    );
    return this.refreshBatchAfterSingleOperation(batch.id);
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
    if (
      items.some(
        item => item.status === 'running' || item.status === 'cutout_running'
      )
    ) {
      throw new CoolCommException('处理中的图片不能重复提交');
    }

    const batchId = items[0].batchId;
    const batch = await this.ensureBatch(batchId);
    await this.ensureBatchNotProcessing(batchId);
    await this.itemEntity.update(
      { id: In(ids) },
      { status: 'pending', error: null }
    );
    await this.batchEntity.update(batchId, {
      status: 'image_generating',
      error: null,
    });
    await this.runItemsWithRetries(items, batch.concurrency, batch.retries);
    return this.refreshBatchAfterSingleOperation(batchId);
  }

  async cutoutItem(id: number) {
    // 单图抠图：对已经生成成功的图片执行 ComfyUI 背景移除，并直接回写当前图片记录。
    const item = await this.itemEntity.findOneBy({ id });
    if (!item) {
      throw new CoolCommException('任务项不存在');
    }
    if (item.status === 'running' || item.status === 'cutout_running') {
      throw new CoolCommException('处理中的图片暂时不能抠图');
    }
    if (
      item.status !== 'success' &&
      !(item.status === 'failed' && item.imageUrl)
    ) {
      throw new CoolCommException('请先生成图片后再抠图');
    }
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      throw new CoolCommException('当前图片文件不存在，请先重新生成');
    }

    const batch = await this.ensureBatch(item.batchId);
    await this.ensureBatchNotProcessing(batch.id);
    const startedAt = Date.now();
    await this.itemEntity.update(id, {
      status: 'cutout_running',
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
        error = this.formatDbError(err, '效果图生成失败：');
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
        error: this.formatDbError(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    } finally {
      await this.refreshBatchStats(batch.id);
      await this.writeArtifacts(batch.id);
    }

    return this.refreshBatchAfterSingleOperation(batch.id);
  }

  async generateMockupItem(id: number) {
    // 单独生成 T 恤效果图：只读取当前印花图，不重新生图，也不重新抠图。
    const item = await this.itemEntity.findOneBy({ id });
    if (!item) {
      throw new CoolCommException('任务项不存在');
    }
    if (item.status === 'running' || item.status === 'cutout_running') {
      throw new CoolCommException('处理中的图片暂时不能生成效果图');
    }
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      throw new CoolCommException('当前图片文件不存在，请先生成图片');
    }

    const batch = await this.ensureBatch(item.batchId);
    await this.ensureBatchNotProcessing(batch.id);
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
      await this.itemEntity.update(id, { error: this.formatDbError(err) });
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
    const createTimeStart = this.normalizeDateTime(query.createTimeStart);
    const createTimeEnd = this.normalizeDateTime(query.createTimeEnd);
    if (createTimeStart) {
      find.andWhere('a.createTime >= :createTimeStart', { createTimeStart });
    }
    if (createTimeEnd) {
      find.andWhere('a.createTime <= :createTimeEnd', { createTimeEnd });
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
    if (item.status === 'running' || item.status === 'cutout_running') {
      throw new CoolCommException('处理中的任务不能编辑');
    }

    await this.itemEntity.update(item.id, {
      prompt: String(params.prompt || '').trim(),
      seoFileName: this.podPromptService.slugify(
        params.seoFileName || item.seoFileName
      ),
      seoTitle: params.seoTitle
        ? String(params.seoTitle).slice(0, 180)
        : item.seoTitle,
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
    if (item.status !== 'pending') {
      return;
    }
    const batch = await this.ensureBatch(item.batchId);
    const settings = await this.podSettingService.getSettings();
    const startedAt = Date.now();
    const attempts = item.attempts + 1;

    const claim = await this.itemEntity.update(
      { id, status: 'pending', promptStatus: 'approved' },
      {
        status: 'running',
        attempts,
        error: null,
      }
    );
    if (!claim.affected) {
      return;
    }

    try {
      const imageDir = path.join(batch.outputDir, 'images');
      const publicDir = path.posix.join(
        this.getBatchPublicDir(batch),
        'images'
      );
      const fileBaseName = this.getImageFileBaseName(item);
      // 最终发给图片模型的 Prompt = 单条差异化 Prompt + 模块统一提示词。
      const finalPrompt = this.podSettingService.appendUnifiedPrompt(
        item.prompt,
        settings
      );
      const imageIndex = Number(item.itemNo || 0) || 0;
      const imageTotal = batch.promptCount || batch.count || 0;
      const providerImageUrl = String(item.providerImageUrl || '').trim();
      console.info(
        this.formatImageRequestLog(batch, item, {
          imageIndex,
          imageTotal,
          attempts,
          maxAttempts: retries + 1,
          fileBaseName,
          model: settings.generation.model,
          endpoint: providerImageUrl || settings.generation.endpoint,
          mode: providerImageUrl ? 'download' : 'generate',
        })
      );
      const result = await this.withGlobalImageSlot(
        settings.generation.concurrency,
        () =>
          this.podImageService.generate({
            prompt: finalPrompt,
            fileBaseName,
            outputDir: imageDir,
            publicDir,
            timeoutMs: batch.timeoutMs,
            providerImageUrl,
            onProviderImageUrl: async url => {
              await this.itemEntity.update(id, { providerImageUrl: url });
            },
          })
      );
      const { postProcessError, ...imageResult } = result;
      let mockupResult = {};
      let error = postProcessError || null;
      if (!postProcessError) {
        try {
          // 只有抠图成功后才自动合成效果图，避免把带背景的原图贴到 T 恤模板上。
          mockupResult = await this.generateMockupResult(batch, imageResult);
        } catch (err) {
          error = this.formatDbError(err, '效果图生成失败：');
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
      const durationMs = Date.now() - startedAt;
      const imageIndex = Number(item.itemNo || 0) || 0;
      const imageTotal = batch.promptCount || batch.count || 0;
      const willRetry = attempts <= retries;
      console.error(
        this.formatImageErrorLog(batch, item, err, {
          imageIndex,
          imageTotal,
          attempts,
          maxAttempts: retries + 1,
          willRetry,
          durationMs,
        })
      );
      // attempts 是本次已经尝试的次数；未超过重试上限时继续递归重跑当前任务。
      if (attempts <= retries) {
        await this.itemEntity.update(id, {
          status: 'pending',
          attempts,
          error: this.formatDbError(err),
          durationMs,
        });
        return;
      }

      const hasExistingImage = Boolean(item.imageUrl && item.filePath);
      await this.itemEntity.update(id, {
        // 重生成失败时，如果原来已有图片，不把旧成果标成失败，避免列表出现“有图但失败”的误导状态。
        status: hasExistingImage ? 'success' : 'failed',
        attempts,
        error: hasExistingImage
          ? this.formatDbError(err, '重新生成失败，已保留原图片：')
          : this.formatDbError(err),
        durationMs,
      });
    } finally {
      await this.refreshBatchStats(batch.id);
      this.scheduleArtifactWrite(batch.id);
    }
  }

  private formatDbError(err: any, prefix = '') {
    const raw = err?.message || String(err || '未知错误');
    const compact = String(raw).replace(/\s+/g, ' ').trim();
    const text = `${prefix}${compact}`;
    // pod_generation_item.error / pod_generation_batch.error 当前是 varchar(1000)，这里预留余量避免 MySQL 写入失败。
    return text.length > 950 ? `${text.slice(0, 950)}...` : text;
  }

  private async finishBatch(id: number) {
    // 根据任务项最终统计回写批次状态；仍有运行/待生成任务时不能提前写终态。
    const stats = await this.refreshBatchStats(id);
    const pendingCount = await this.itemEntity.countBy({
      batchId: id,
      status: 'pending',
      promptStatus: 'approved',
    });
    const activeCount = await this.countActiveItems(id);
    const status = this.resolveBatchStatus(stats, pendingCount, activeCount);
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
    this.clearArtifactTimer(batchId);
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
        .map(value => this.csvCell(value))
        .join(',')
    );
    return [header.join(','), ...rows].join('\n');
  }

  private async refreshBatchAfterSingleOperation(id: number) {
    const stats = await this.refreshBatchStats(id);
    const pendingCount = await this.itemEntity.countBy({
      batchId: id,
      status: 'pending',
      promptStatus: 'approved',
    });
    const activeCount = await this.countActiveItems(id);
    const status = this.resolveBatchStatus(stats, pendingCount, activeCount);
    await this.batchEntity.update(id, { status });
    await this.writeArtifacts(id);
    return this.infoWithItems(id);
  }

  private resolveBatchStatus(
    stats: {
      successCount: number;
      failedCount: number;
      promptCount: number;
      approvedPromptCount: number;
    },
    pendingCount: number,
    activeCount: number
  ) {
    if (activeCount > 0) {
      return 'image_generating';
    }
    if (pendingCount > 0) {
      return 'prompt_ready';
    }
    if (!stats.approvedPromptCount) {
      return 'prompt_ready';
    }
    return stats.failedCount === 0
      ? 'completed'
      : stats.successCount > 0
      ? 'partial_failed'
      : 'failed';
  }

  private async countActiveItems(batchId: number) {
    return this.itemEntity.count({
      where: {
        batchId,
        status: In(['running', 'cutout_running']),
      },
    });
  }

  private async ensureBatchNotProcessing(batchId: number) {
    if (
      this.runningBatchIds.has(batchId) ||
      (await this.countActiveItems(batchId)) > 0
    ) {
      throw new CoolCommException('当前批次正在生成中，请稍后再操作单张图片');
    }
  }

  private acquireBatchLock(id: number) {
    if (this.runningBatchIds.has(id)) {
      return false;
    }
    this.runningBatchIds.add(id);
    return true;
  }

  private releaseBatchLock(id: number) {
    this.runningBatchIds.delete(id);
  }

  private async runItemsWithRetries(
    items: PodGenerationItemEntity[],
    concurrency: number,
    retries: number
  ) {
    let queue = items;
    while (queue.length) {
      await this.runPool(queue, concurrency, item =>
        this.runItem(item.id, retries)
      );
      const retryIds = queue.map(item => item.id).filter(Boolean);
      queue = retryIds.length
        ? await this.itemEntity.find({
            where: {
              id: In(retryIds),
              status: 'pending',
              promptStatus: 'approved',
            },
            order: { id: 'ASC' },
          })
        : [];
    }
  }

  private async withGlobalImageSlot<T>(
    limit: number,
    worker: () => Promise<T>
  ) {
    const max = this.clamp(Number(limit || 1), 1, 100);
    const maxQueue = max * 100;
    while (this.activeImageTasks >= max) {
      if (this.imageWaitQueue.length >= maxQueue) {
        throw new CoolCommException('图片生成队列已满，请稍后再试');
      }
      await this.waitForImageSlot(max);
    }

    this.activeImageTasks += 1;
    try {
      return await worker();
    } finally {
      this.activeImageTasks = Math.max(0, this.activeImageTasks - 1);
      this.wakeNextImageWaiter();
    }
  }

  private waitForImageSlot(limit: number) {
    const timeoutMs = 10 * 60 * 1000;
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(waiter.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          const index = this.imageWaitQueue.indexOf(waiter);
          if (index >= 0) {
            this.imageWaitQueue.splice(index, 1);
          }
          reject(new Error(`图片生成队列等待超时，当前全局并发上限 ${limit}`));
        }, timeoutMs),
      };
      this.imageWaitQueue.push(waiter);
    });
  }

  private wakeNextImageWaiter() {
    const next = this.imageWaitQueue.shift();
    next?.resolve();
  }

  private scheduleArtifactWrite(batchId: number) {
    this.clearArtifactTimer(batchId);
    const timer = setTimeout(() => {
      this.artifactTimers.delete(batchId);
      this.writeArtifacts(batchId).catch(err => {
        console.warn(
          `[POD_ARTIFACT_WRITE_FAIL] batch=${batchId} msg="${this.compactLogText(
            err?.message || err,
            160
          )}"`
        );
      });
    }, 1500);
    this.artifactTimers.set(batchId, timer);
  }

  private clearArtifactTimer(batchId: number) {
    const timer = this.artifactTimers.get(batchId);
    if (timer) {
      clearTimeout(timer);
      this.artifactTimers.delete(batchId);
    }
  }

  private csvCell(value: any) {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) {
      text = `'${text}`;
    }
    return `"${text.replace(/"/g, '""')}"`;
  }

  private getBatchPublicDir(batch: PodGenerationBatchEntity) {
    const normalized = String(batch.outputDir || '')
      .split(path.sep)
      .join('/');
    const marker = '/generated/';
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) {
      return normalized.slice(index);
    }

    const relativeMarker = 'generated/';
    const relativeIndex = normalized.lastIndexOf(relativeMarker);
    if (relativeIndex >= 0) {
      return `/${normalized.slice(relativeIndex)}`;
    }

    return path.posix.join(
      '/generated',
      moment(batch.createTime).format('YYYY-MM-DD'),
      batch.topicSlug
    );
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
      batchPublicDir: this.getBatchPublicDir(batch),
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
    const base = this.podPromptService.slugify(
      value || `pod-tshirt-print-${index + 1}`
    );
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

  private formatImageRequestLog(
    batch: PodGenerationBatchEntity,
    item: PodGenerationItemEntity,
    data: {
      imageIndex: number;
      imageTotal: number;
      attempts: number;
      maxAttempts: number;
      fileBaseName: string;
      model: string;
      endpoint: string;
      mode: 'generate' | 'download';
    }
  ) {
    return [
      '[POD_IMG_REQ]',
      `batch=${batch.id}/${batch.batchNo}`,
      `img=${data.imageIndex}/${data.imageTotal}`,
      `item=${item.id}/${item.itemNo}`,
      `try=${data.attempts}/${data.maxAttempts}`,
      `cc=${batch.concurrency}`,
      `mode=${data.mode}`,
      `model=${data.model || '-'}`,
      `host=${this.getUrlHost(data.endpoint)}`,
      `file="${this.compactLogText(data.fileBaseName, 80)}"`,
    ].join(' ');
  }

  private formatImageErrorLog(
    batch: PodGenerationBatchEntity,
    item: PodGenerationItemEntity,
    err: any,
    data: {
      imageIndex: number;
      imageTotal: number;
      attempts: number;
      maxAttempts: number;
      willRetry: boolean;
      durationMs: number;
    }
  ) {
    return [
      '[POD_IMG_ERR]',
      `batch=${batch.id}/${batch.batchNo}`,
      `img=${data.imageIndex}/${data.imageTotal}`,
      `item=${item.id}/${item.itemNo}`,
      `try=${data.attempts}/${data.maxAttempts}`,
      `retry=${data.willRetry ? 'yes' : 'no'}`,
      `cost=${data.durationMs}ms`,
      `status=${err?.response?.status || '-'}`,
      `code=${err?.code || '-'}`,
      `host=${this.getUrlHost(err?.config?.url)}`,
      `msg="${this.compactLogText(err?.message || '', 160)}"`,
    ].join(' ');
  }

  private getUrlHost(value: string) {
    try {
      return value ? new URL(value).host : '-';
    } catch {
      return '-';
    }
  }

  private compactLogText(value: string, maxLength: number) {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
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

  private normalizeDateTime(value: any) {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }
    const time = moment(text);
    if (!time.isValid()) {
      return '';
    }
    return time.format('YYYY-MM-DD HH:mm:ss');
  }

  private pickText(row: any, keys: string[]) {
    for (const key of keys) {
      const value = row[key];
      if (value !== undefined && value !== null && String(value).trim()) {
        return String(value).trim();
      }
    }
    return '';
  }

  private pickNumber(row: any, keys: string[]) {
    for (const key of keys) {
      const value = row[key];
      if (
        value !== undefined &&
        value !== null &&
        String(value).trim() !== ''
      ) {
        const num = Number(value);
        return Number.isNaN(num) ? undefined : num;
      }
    }
    return undefined;
  }

  private clamp(value: number, min: number, max: number) {
    if (Number.isNaN(value)) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }
}
