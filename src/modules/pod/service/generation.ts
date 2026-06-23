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
import { PodGenerationImportEntity } from '../entity/import';
import { PodGenerationImportRowEntity } from '../entity/import-row';
import { PodPromptService } from './prompt';
import { PodImageService } from './image';
import { PodPromptModelService } from './prompt-model';
import { PodSettingService } from './setting';
import { PodMockupService } from './mockup';

class ImportRunNotAcquiredError extends Error {
  constructor(message = '当前导入任务正在执行中或已结束') {
    super(message);
    this.name = 'ImportRunNotAcquiredError';
  }
}

interface PostProcessStats {
  cutoutFailedCount: number;
  cutoutPendingCount: number;
  mockupFailedCount: number;
  mockupMissingCount: number;
  verifyFailedCount: number;
}

/**
 * POD批量生成
 */
@Provide()
export class PodGenerationService extends BaseService {
  @InjectEntityModel(PodGenerationBatchEntity)
  batchEntity: Repository<PodGenerationBatchEntity>;

  @InjectEntityModel(PodGenerationItemEntity)
  itemEntity: Repository<PodGenerationItemEntity>;

  @InjectEntityModel(PodGenerationImportEntity)
  importEntity: Repository<PodGenerationImportEntity>;

  @InjectEntityModel(PodGenerationImportRowEntity)
  importRowEntity: Repository<PodGenerationImportRowEntity>;

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
  private runningImportIds = new Set<number>();

  @Init()
  async init() {
    await super.init();
    // Cool 的基础 CRUD 仍然作用在“批次”表上，图片任务项单独走自定义接口。
    this.setEntity(this.batchEntity);
    setImmediate(() => {
      this.recoverImportTasks({ staleMinutes: 0 }).catch(err => {
        console.error(
          `[POD_IMPORT_RECOVER_INIT_FAILED] error=${this.formatDbError(err)}`
        );
      });
    });
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
      await manager.update(
        PodGenerationImportRowEntity,
        { batchId: In(idArr) },
        {
          batchId: null,
          batchNo: null,
          status: 'failed',
          error: '关联批次已删除',
        }
      );
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
    const importRowId = params.importRowId ? Number(params.importRowId) : null;
    if (importRowId) {
      const existingBatch = await this.batchEntity.findOne({
        where: { importRowId },
        order: { id: 'DESC' },
      });
      if (existingBatch) {
        await this.importRowEntity.update(importRowId, {
          batchId: existingBatch.id,
          batchNo: existingBatch.batchNo,
        });
        throw new CoolCommException(
          '该导入行已存在批次，请使用导入行修复继续处理'
        );
      }
    }

    // 读取后台“模块设置”，让接口地址、模型、尺寸、输出目录等参数可以动态调整。
    const settings = await this.podSettingService.getSettings();
    const count = this.clamp(Number(params.count || 10), 1, 100);
    const providerConcurrency = Number(settings.generation.concurrency || 0);
    const concurrency = this.clamp(Number(providerConcurrency || 3), 1, 100);
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
      importId: params.importId ? Number(params.importId) : null,
      importRowId,
      options: {
        providerId: settings.generation.providerId,
        provider: settings.generation.provider || 'mock',
        providerName: settings.generation.providerName,
      },
    });
    if (importRowId) {
      await this.importRowEntity.update(importRowId, {
        status: 'prompt_generating',
        batchId: batch.id,
        batchNo: batch.batchNo,
        error: null,
      });
    }

    try {
      await this.createPromptItemsForBatch(batch, topic, count, autoRun, settings);
      if (autoRun) {
        // 自动生图默认不阻塞创建接口；导入任务可要求串行等待当前批次结束。
        await this.batchEntity.update(batch.id, { status: 'image_generating' });
        if (importRowId) {
          await this.importRowEntity.update(importRowId, {
            status: 'image_generating',
            batchId: batch.id,
            batchNo: batch.batchNo,
            error: null,
          });
        }
        await this.writeArtifacts(batch.id);
        if (params.runInline === true) {
          return this.runBatch(batch.id);
        }
        this.runBatchInBackground(batch.id);
        return this.infoWithItems(batch.id);
      }

      // 关闭自动生图时，保持原有人工审批流程。
      await this.batchEntity.update(batch.id, { status: 'prompt_ready' });
      if (importRowId) {
        await this.importRowEntity.update(importRowId, {
          status: 'created',
          batchId: batch.id,
          batchNo: batch.batchNo,
          error: null,
        });
      }
      await this.writeArtifacts(batch.id);
      return this.infoWithItems(batch.id);
    } catch (err) {
      await this.batchEntity.update(batch.id, {
        status: 'failed',
        error: this.formatDbError(err),
      });
      err.podBatchId = batch.id;
      err.podBatchNo = batch.batchNo;
      throw err;
    }
  }

  async createBatches(params: any = {}) {
    // Excel 导入入口：先把原始行完整入库，再由后台导入任务按行号串行创建批次和生图。
    let rows = [];
    if (Array.isArray(params.rows)) {
      rows = params.rows;
    } else if (Array.isArray(params.list)) {
      rows = params.list;
    }
    if (!rows.length) {
      throw new CoolCommException('请上传至少一条批次数据');
    }

    const importRecord = await this.importEntity.save({
      importNo: this.createImportNo(),
      fileName: String(params.fileName || params.filename || '').slice(0, 220),
      status: 'pending',
      totalRows: rows.length,
      successRows: 0,
      failedRows: 0,
      totalImages: 0,
      options: {
        autoRun: true,
        retries: params.retries,
        timeoutMs: params.timeoutMs,
      },
    });
    const results = [];
    let queued = 0;
    let totalImages = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] || {};
      const topic = this.pickText(row, ['topic', '主题', '生成主题', '题目']);
      const count = this.pickNumber(row, ['count', '数量', '张数', '生成数量']);
      const retries = this.pickNumber(row, [
        'retries',
        '失败重试',
        '重试',
        '重试次数',
      ]);
      const rowNo = index + 2;
      const importRow = await this.importRowEntity.save({
        importId: importRecord.id,
        rowNo,
        topic,
        count: count || 0,
        status: 'pending',
        rawData: row,
      });

      if (!topic) {
        const result = {
          rowNo,
          status: 'failed',
          error: '主题不能为空',
        };
        await this.importRowEntity.update(importRow.id, result);
        results.push(result);
        continue;
      }
      if (!count || count < 1) {
        const result = {
          rowNo,
          topic,
          status: 'failed',
          error: '数量必须大于 0',
        };
        await this.importRowEntity.update(importRow.id, result);
        results.push(result);
        continue;
      }
      queued++;
      totalImages += count;
      results.push({
        rowNo,
        topic,
        count,
        status: 'pending',
      });
    }

    const failed = results.filter(item => item.status === 'failed').length;
    const status = queued > 0 ? 'pending' : 'failed';
    await this.importEntity.update(importRecord.id, {
      status,
      successRows: 0,
      failedRows: failed,
      totalImages,
      error:
        failed && !queued
          ? `${failed} 行导入失败`
          : failed
          ? `${failed} 行格式校验失败，其余行已进入队列`
          : null,
    });
    if (queued > 0) {
      this.runImportInBackground(importRecord.id);
    }
    return {
      importId: importRecord.id,
      importNo: importRecord.importNo,
      total: results.length,
      success: queued,
      failed,
      queued,
      totalImages,
      results,
    };
  }

  private async createPromptItemsForBatch(
    batch: PodGenerationBatchEntity,
    topic: string,
    count: number,
    autoRun: boolean,
    settings: any
  ) {
    // 一次性让提示词模型返回指定数量的差异化 Prompt，再拆成图片任务项。
    // 注意：导入任务恢复、服务热重载或多实例同时处理同一导入行时，可能在
    // “批次已创建、提示词尚未落库”的窗口重复进入这里。先做一次快速幂等检查，
    // 生成模型返回后再用批次行锁做最终检查，避免同一批次反复追加 001-005。
    const existingCount = await this.itemEntity.countBy({ batchId: batch.id });
    if (existingCount > 0) {
      await this.refreshBatchStats(batch.id);
      return;
    }

    const prompts = await this.podPromptModelService.generate(topic, count);
    const promptSource = this.podPromptModelService.getPromptSource(settings);
    const used = new Set<string>();

    await this.batchEntity.manager.transaction(async manager => {
      await manager.findOne(PodGenerationBatchEntity, {
        where: { id: batch.id },
        lock: { mode: 'pessimistic_write' },
      });
      const lockedExistingCount = await manager.count(PodGenerationItemEntity, {
        where: { batchId: batch.id },
      });
      if (lockedExistingCount > 0) {
        return;
      }

      await manager.save(
        PodGenerationItemEntity,
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
    });

    await this.refreshBatchStats(batch.id);
  }

  async retryImportRow(id: number) {
    const row = await this.importRowEntity.findOneBy({ id: Number(id) });
    if (!row) {
      throw new CoolCommException('导入行不存在');
    }
    if (row.batchId) {
      throw new CoolCommException('该导入行已创建批次，请进入批次修复');
    }
    if (!row.topic) {
      throw new CoolCommException('导入行主题为空，无法重试创建批次');
    }
    if (!row.count || row.count < 1) {
      throw new CoolCommException('导入行数量无效，无法重试创建批次');
    }

    await this.importRowEntity.update(row.id, {
      status: 'pending',
      error: null,
    });

    try {
      await this.processImportRow(row.id);
    } catch (err) {
      await this.importRowEntity.update(row.id, {
        status: 'failed',
        batchId: err.podBatchId || null,
        batchNo: err.podBatchNo || null,
        error: this.formatDbError(err),
      });
      throw err;
    } finally {
      await this.refreshImportStats(row.importId);
    }

    return this.importRowEntity.findOneBy({ id: row.id });
  }

  async repairImportRow(id: number) {
    const row = await this.importRowEntity.findOneBy({ id: Number(id) });
    if (!row) {
      throw new CoolCommException('导入行不存在');
    }
    if (!row.batchId) {
      return this.retryImportRow(row.id);
    }
    return this.processImportRowBatch(row, row.batchId);
  }

  async repairImport(id: number) {
    const importId = Number(id);
    const record = await this.importEntity.findOneBy({ id: importId });
    if (!record) {
      throw new CoolCommException('导入记录不存在');
    }
    const rows = await this.importRowEntity.find({
      where: { importId },
      order: { rowNo: 'ASC', id: 'ASC' },
    });
    const results = [];
    for (const row of rows) {
      try {
        if (row.batchId) {
          const updated = await this.processImportRowBatch(row, row.batchId);
          results.push({
            rowId: row.id,
            rowNo: row.rowNo,
            status: updated?.status === 'completed' ? 'repaired' : 'failed',
          });
        } else if (row.status === 'failed' || row.status === 'pending') {
          const updated = await this.retryImportRow(row.id);
          results.push({
            rowId: row.id,
            rowNo: row.rowNo,
            status: updated?.status || 'completed',
          });
        }
      } catch (err) {
        results.push({
          rowId: row.id,
          rowNo: row.rowNo,
          status: 'failed',
          error: this.formatDbError(err),
        });
      }
    }
    await this.refreshImportStats(importId);
    return {
      importId,
      results,
    };
  }

  async runImport(
    id: number,
    options: { staleMinutes?: number; preAcquired?: boolean } = {}
  ) {
    const importId = Number(id);
    if (!importId) {
      throw new CoolCommException('导入记录ID无效');
    }
    if (this.runningImportIds.has(importId)) {
      throw new CoolCommException('当前导入任务正在执行中，请勿重复执行');
    }

    this.runningImportIds.add(importId);
    try {
      const acquired =
        options.preAcquired === true ||
        (await this.acquireImportRun(importId, Number(options.staleMinutes ?? 30)));
      if (!acquired) {
        throw new ImportRunNotAcquiredError();
      }

      const rows = await this.importRowEntity.find({
        where: { importId },
        order: { rowNo: 'ASC', id: 'ASC' },
      });
      for (const row of rows) {
        if (row.status === 'failed' || row.status === 'completed') {
          continue;
        }
        if (
          ![
            'pending',
            'creating_batch',
            'prompt_generating',
            'image_generating',
            'post_processing',
            'verifying',
          ].includes(row.status)
        ) {
          continue;
        }
        try {
          const updated = await this.processImportRow(row.id);
          if (
            ['prompt_generating', 'image_generating'].includes(
              updated?.status
            )
          ) {
            break;
          }
        } catch (err) {
          console.error(
            `[POD_IMPORT_ROW_FAILED] import=${importId} row=${row.id} rowNo=${row.rowNo} error=${this.formatDbError(err)}`
          );
        }
      }
      await this.refreshImportStats(importId);
      return this.importEntity.findOneBy({ id: importId });
    } finally {
      this.runningImportIds.delete(importId);
    }
  }

  async recoverImportTasks(options: { staleMinutes?: number; limit?: number } = {}) {
    const staleMinutes = Number(options.staleMinutes ?? 30);
    const limit = this.clamp(Number(options.limit || 5), 1, 50);
    const cutoff = moment()
      .subtract(Math.max(staleMinutes, 0), 'minutes')
      .format('YYYY-MM-DD HH:mm:ss');
    const find = this.importEntity
      .createQueryBuilder('a')
      .where('a.status = :pending', { pending: 'pending' });
    if (staleMinutes > 0) {
      find.orWhere('(a.status = :running and a.updateTime <= :cutoff)', {
        running: 'running',
        cutoff,
      });
    }
    const records = await find.orderBy('a.id', 'ASC').limit(limit).getMany();

    let acquiredCount = 0;
    for (const record of records) {
      if (this.runningImportIds.has(record.id)) {
        continue;
      }
      const acquired = await this.acquireImportRun(record.id, staleMinutes);
      if (!acquired) {
        continue;
      }
      acquiredCount += 1;
      this.runImportInBackground(record.id, staleMinutes, true);
    }
    return acquiredCount;
  }

  private async acquireImportRun(importId: number, staleMinutes = 30) {
    const cutoff = moment()
      .subtract(Math.max(staleMinutes, 0), 'minutes')
      .format('YYYY-MM-DD HH:mm:ss');
    const find = this.importEntity
      .createQueryBuilder()
      .update(PodGenerationImportEntity)
      .set({
        status: 'running',
        error: null,
        updateTime: moment().format('YYYY-MM-DD HH:mm:ss') as any,
      })
      .where('id = :importId', { importId });
    if (staleMinutes > 0) {
      find.andWhere(
        '(status = :pending or (status = :running and updateTime <= :cutoff))',
        {
          pending: 'pending',
          running: 'running',
          cutoff,
        }
      );
    } else {
      find.andWhere('status = :pending', { pending: 'pending' });
    }
    const result = await find.execute();
    return Number(result.affected || 0) > 0;
  }

  private runImportInBackground(
    id: number,
    staleMinutes = 30,
    preAcquired = false
  ) {
    setImmediate(() => {
      if (this.runningImportIds.has(id)) {
        console.warn(`[POD_IMPORT_SKIP] import=${id} reason=already-running`);
        return;
      }
      this.runImport(id, { staleMinutes, preAcquired }).catch(async err => {
        if (err instanceof ImportRunNotAcquiredError) {
          console.warn(
            `[POD_IMPORT_SKIP] import=${id} reason=not-acquired message=${err.message}`
          );
          return;
        }
        await this.importEntity.update(id, {
          status: 'failed',
          error: this.formatDbError(err),
        });
        console.error(
          `[POD_IMPORT_FAILED] import=${id} error=${this.formatDbError(err)}`
        );
      });
    });
  }

  private async processImportRow(id: number) {
    const row = await this.importRowEntity.findOneBy({ id: Number(id) });
    if (!row) {
      throw new CoolCommException('导入行不存在');
    }
    if (row.batchId) {
      return this.processImportRowBatch(row, row.batchId);
    }
    if (!row.topic) {
      throw new CoolCommException('导入行主题为空，无法处理');
    }
    if (!row.count || row.count < 1) {
      throw new CoolCommException('导入行数量无效，无法处理');
    }

    const existingBatch = await this.batchEntity.findOne({
      where: { importRowId: row.id },
      order: { id: 'DESC' },
    });
    if (existingBatch) {
      await this.importRowEntity.update(row.id, {
        batchId: existingBatch.id,
        batchNo: existingBatch.batchNo,
      });
      return this.processImportRowBatch(row, existingBatch.id);
    }

    const record = await this.importEntity.findOneBy({ id: row.importId });
    const options = record?.options || {};
    await this.importRowEntity.update(row.id, {
      status: 'creating_batch',
      error: null,
    });

    try {
      const batch = await this.createBatch({
        topic: row.topic,
        count: row.count,
        retries: options.retries,
        timeoutMs: options.timeoutMs,
        autoRun: true,
        runInline: true,
        importId: row.importId,
        importRowId: row.id,
      });
      await this.importRowEntity.update(row.id, {
        status: this.isBatchTerminalSuccess(batch.status)
          ? 'completed'
          : 'failed',
        batchId: batch.id,
        batchNo: batch.batchNo,
        error: this.isBatchTerminalSuccess(batch.status)
          ? null
          : batch.error || `批次状态：${batch.status}`,
      });
    } catch (err) {
      await this.importRowEntity.update(row.id, {
        status: 'failed',
        batchId: err.podBatchId || null,
        batchNo: err.podBatchNo || null,
        error: this.formatDbError(err),
      });
      throw err;
    } finally {
      await this.refreshImportStats(row.importId);
    }

    return this.importRowEntity.findOneBy({ id: row.id });
  }

  private async processImportRowBatch(
    row: PodGenerationImportRowEntity,
    batchId: number
  ) {
    const batch = await this.ensureBatch(batchId);
    const activeCount = await this.countActiveItems(batch.id);
    if (activeCount > 0 || this.runningBatchIds.has(batch.id)) {
      await this.importRowEntity.update(row.id, {
        status: 'image_generating',
        batchId: batch.id,
        batchNo: batch.batchNo,
        error: null,
      });
      await this.refreshImportStats(row.importId);
      return this.importRowEntity.findOneBy({ id: row.id });
    }

    const promptCount = await this.itemEntity.countBy({ batchId: batch.id });
    if (!promptCount) {
      if (batch.status === 'prompt_generating') {
        await this.importRowEntity.update(row.id, {
          status: 'prompt_generating',
          batchId: batch.id,
          batchNo: batch.batchNo,
          error: null,
        });
        await this.refreshImportStats(row.importId);
        return this.importRowEntity.findOneBy({ id: row.id });
      }
      if (!this.acquireBatchLock(batch.id)) {
        await this.importRowEntity.update(row.id, {
          status: 'prompt_generating',
          batchId: batch.id,
          batchNo: batch.batchNo,
          error: null,
        });
        await this.refreshImportStats(row.importId);
        return this.importRowEntity.findOneBy({ id: row.id });
      }
      // 这是批次已创建但提示词尚未落库时的恢复路径；沿用批次初始配置，避免恢复时切换供应商或输出目录。
      try {
        await this.importRowEntity.update(row.id, {
          status: 'prompt_generating',
          batchId: batch.id,
          batchNo: batch.batchNo,
          error: null,
        });
        await this.batchEntity.update(batch.id, {
          status: 'prompt_generating',
          error: null,
        });
        const settings = await this.podSettingService.getSettings();
        await this.createPromptItemsForBatch(
          batch,
          batch.topic,
          batch.count,
          true,
          settings
        );
        await this.batchEntity.update(batch.id, { status: 'image_generating' });
      } finally {
        this.releaseBatchLock(batch.id);
      }
      const result = await this.runBatch(batch.id);
      return this.finishImportRowFromBatch(row, result);
    }

    if (
      this.isBatchTerminalSuccess(batch.status) &&
      !(await this.hasPostProcessRepairableItems(batch.id))
    ) {
      return this.finishImportRowFromBatch(row, batch);
    }

    const pendingApproved = await this.itemEntity.countBy({
      batchId: batch.id,
      status: 'pending',
      promptStatus: 'approved',
    });
    const result = pendingApproved
      ? await this.runBatch(batch.id)
      : await this.repairBatchFailures(batch.id);
    return this.finishImportRowFromBatch(row, result);
  }

  private async finishImportRowFromBatch(
    row: PodGenerationImportRowEntity,
    batch: any
  ) {
    const rowStatus = await this.resolveImportRowStatusFromBatch(batch);
    await this.importRowEntity.update(row.id, {
      status: rowStatus,
      batchId: batch.id,
      batchNo: batch.batchNo,
      error: await this.resolveImportRowErrorFromBatch(batch),
    });
    await this.refreshImportStats(row.importId);
    return this.importRowEntity.findOneBy({ id: row.id });
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
      await this.retryImageFailuresOnce(batch);
      await this.retryPostProcessFailures(id);
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
        {
          status: 'pending',
          error: null,
          providerImageUrl: null,
          cutoutStatus: 'pending',
          cutoutError: null,
          mockupStatus: 'pending',
          mockupError: null,
          mockupAttempts: 0,
          verifyStatus: 'pending',
          verifyError: null,
        }
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
      await this.retryPostProcessFailures(id);
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
    await this.itemEntity.update(id, {
      status: 'pending',
      error: null,
      providerImageUrl: null,
      cutoutStatus: 'pending',
      cutoutError: null,
      mockupStatus: 'pending',
      mockupError: null,
      mockupAttempts: 0,
      verifyStatus: 'pending',
      verifyError: null,
    });
    const pendingItem = await this.itemEntity.findOneBy({ id });
    await this.runItemsWithRetries(
      pendingItem ? [pendingItem] : [],
      1,
      batch.retries
    );
    await this.retryPostProcessFailures(batch.id);
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
      {
        status: 'pending',
        attempts: 0,
        error: null,
        providerImageUrl: null,
        cutoutStatus: 'pending',
        cutoutError: null,
        mockupStatus: 'pending',
        mockupError: null,
        mockupAttempts: 0,
        verifyStatus: 'pending',
        verifyError: null,
      }
    );
    await this.batchEntity.update(batchId, {
      status: 'image_generating',
      error: null,
    });
    await this.runItemsWithRetries(items, batch.concurrency, batch.retries);
    await this.retryPostProcessFailures(batchId);
    return this.refreshBatchAfterSingleOperation(batchId);
  }

  async repairBatchFailures(id: number) {
    if (!this.acquireBatchLock(id)) {
      throw new CoolCommException('当前批次正在生成中，请勿重复执行');
    }

    try {
      const batch = await this.ensureBatch(id);
      if ((await this.countActiveItems(id)) > 0) {
        throw new CoolCommException('当前批次正在生成中，请稍后再修复');
      }
      await this.batchEntity.update(id, {
        status: 'image_generating',
        error: null,
      });
      await this.retryImageFailuresOnce(batch);
      await this.retryPostProcessFailures(id);
      return this.finishBatch(id);
    } finally {
      this.releaseBatchLock(id);
    }
  }

  async recheckArtifacts(id: number) {
    await this.ensureBatchNotProcessing(id);
    return this.refreshBatchAfterSingleOperation(id);
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
      cutoutStatus: 'running',
      error: null,
      cutoutError: null,
      verifyStatus: 'pending',
      verifyError: null,
    });

    try {
      const result = await this.podImageService.cutout({
        fileName: item.fileName,
        filePath: item.filePath,
        imageUrl: item.imageUrl,
        context: this.createCutoutContext(batch, item),
      });
      const { postProcessError, ...imageResult } = result;
      let mockupResult = {};
      let error = postProcessError || null;
      let mockupStatus = 'success';
      let mockupError = null;
      let mockupAttempts = Number(item.mockupAttempts || 0);
      try {
        mockupAttempts += 1;
        mockupResult = await this.generateMockupResult(batch, imageResult);
      } catch (err) {
        mockupStatus = 'failed';
        mockupError = this.formatDbError(err, '效果图生成失败：');
        error = mockupError;
      }

      await this.itemEntity.update(id, {
        ...imageResult,
        ...mockupResult,
        status: 'success',
        cutoutStatus: postProcessError ? 'failed' : 'success',
        cutoutAttempts: Number(item.cutoutAttempts || 0) + 1,
        cutoutError: postProcessError || null,
        mockupStatus,
        mockupError,
        mockupAttempts,
        error,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      // 抠图失败不代表原图生成失败；保留已有图片和重试入口，只记录本次抠图错误。
      const error = this.formatDbError(err);
      await this.itemEntity.update(id, {
        status: item.imageUrl ? 'success' : 'failed',
        cutoutStatus: 'failed',
        cutoutAttempts: Number(item.cutoutAttempts || 0) + 1,
        cutoutError: error,
        error,
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
        mockupStatus: 'success',
        mockupError: null,
        mockupAttempts: Number(item.mockupAttempts || 0) + 1,
        verifyStatus: 'pending',
        verifyError: null,
      });
      await this.writeArtifacts(batch.id);
      return this.itemEntity.findOneBy({ id });
    } catch (err) {
      const error = this.formatDbError(err);
      await this.itemEntity.update(id, {
        error,
        mockupStatus: 'failed',
        mockupError: error,
        mockupAttempts: Number(item.mockupAttempts || 0) + 1,
      });
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
    if (query.cutoutStatus) {
      find.andWhere('a.cutoutStatus = :cutoutStatus', {
        cutoutStatus: query.cutoutStatus,
      });
    }
    if (query.mockupStatus) {
      find.andWhere('a.mockupStatus = :mockupStatus', {
        mockupStatus: query.mockupStatus,
      });
    }
    if (query.verifyStatus) {
      find.andWhere('a.verifyStatus = :verifyStatus', {
        verifyStatus: query.verifyStatus,
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
        cutoutStatus: settings.cutout?.enabled ? 'running' : 'skipped',
        cutoutError: null,
        mockupStatus: 'pending',
        mockupError: null,
        verifyStatus: 'pending',
        verifyError: null,
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
            cutoutContext: this.createCutoutContext(batch, item),
            onProviderImageUrl: async url => {
              await this.itemEntity.update(id, { providerImageUrl: url });
            },
          })
      );
      const { postProcessError, ...imageResult } = result;
      let mockupResult = {};
      let error = postProcessError || null;
      let mockupStatus = 'pending';
      let mockupError = null;
      let mockupAttempts = Number(item.mockupAttempts || 0);
      if (!postProcessError) {
        try {
          // 只有抠图成功后才自动合成效果图，避免把带背景的原图贴到 T 恤模板上。
          mockupAttempts += 1;
          mockupResult = await this.generateMockupResult(batch, imageResult);
          mockupStatus = 'success';
        } catch (err) {
          mockupStatus = 'failed';
          mockupError = this.formatDbError(err, '效果图生成失败：');
          error = mockupError;
        }
      }

      await this.itemEntity.update(id, {
        ...imageResult,
        ...mockupResult,
        status: 'success',
        cutoutStatus: settings.cutout?.enabled
          ? postProcessError
            ? 'failed'
            : 'success'
          : 'skipped',
        cutoutAttempts: settings.cutout?.enabled
          ? Number(item.cutoutAttempts || 0) + 1
          : Number(item.cutoutAttempts || 0),
        cutoutError: postProcessError || null,
        mockupStatus: postProcessError ? 'skipped' : mockupStatus,
        mockupError,
        mockupAttempts,
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
          cutoutStatus: 'pending',
          cutoutError: null,
          mockupStatus: 'pending',
          mockupError: null,
          durationMs,
        });
        return;
      }

      const hasExistingImage = Boolean(item.imageUrl && item.filePath);
      await this.itemEntity.update(id, {
        // 重生成失败时，如果原来已有图片，不把旧成果标成失败，避免列表出现“有图但失败”的误导状态。
        status: hasExistingImage ? 'success' : 'failed',
        attempts,
        cutoutStatus: hasExistingImage ? item.cutoutStatus : 'skipped',
        mockupStatus: hasExistingImage ? item.mockupStatus : 'skipped',
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

  private async retryPostProcessFailures(batchId: number) {
    const batch = await this.ensureBatch(batchId);
    const items = await this.itemEntity.find({
      where: {
        batchId,
        status: 'success',
      },
      order: { id: 'ASC' },
    });

    const cutoutRetryableItems = items.filter(item =>
      this.isCutoutRepairableItem(item)
    );
    for (const item of cutoutRetryableItems) {
      await this.retryCutoutOnly(batch, item);
    }

    await this.retryMockupFailures(batchId);
  }

  private async hasPostProcessRepairableItems(batchId: number) {
    const items = await this.itemEntity.find({
      where: {
        batchId,
        status: 'success',
      },
      order: { id: 'ASC' },
    });
    return items.some(
      item =>
        this.isCutoutRepairableItem(item) || this.isMockupRepairableItem(item)
    );
  }

  private isCutoutRepairableItem(item: PodGenerationItemEntity) {
    return (
      item.cutoutStatus === 'failed' &&
      Boolean(item.filePath) &&
      fs.existsSync(item.filePath)
    );
  }

  private async retryImageFailuresOnce(batch: PodGenerationBatchEntity) {
    const failedItems = await this.itemEntity.find({
      where: {
        batchId: batch.id,
        status: 'failed',
        promptStatus: 'approved',
      },
      order: { id: 'ASC' },
    });
    if (!failedItems.length) {
      return;
    }

    await this.itemEntity.update(
      { id: In(failedItems.map(item => item.id)) },
      {
        status: 'pending',
        error: null,
        providerImageUrl: null,
        cutoutStatus: 'pending',
        cutoutError: null,
        mockupStatus: 'pending',
        mockupError: null,
        mockupAttempts: 0,
        verifyStatus: 'pending',
        verifyError: null,
      }
    );
    const retryItems = await this.itemEntity.find({
      where: {
        id: In(failedItems.map(item => item.id)),
        status: 'pending',
        promptStatus: 'approved',
      },
      order: { id: 'ASC' },
    });
    await this.runItemsWithRetries(retryItems, batch.concurrency, 0);
  }

  private async retryCutoutOnly(
    batch: PodGenerationBatchEntity,
    item: PodGenerationItemEntity
  ) {
    const startedAt = Date.now();
    await this.itemEntity.update(item.id, {
      status: 'cutout_running',
      cutoutStatus: 'running',
      cutoutError: null,
      verifyStatus: 'pending',
      verifyError: null,
    });

    try {
      const result = await this.podImageService.cutout({
        fileName: item.fileName,
        filePath: item.filePath,
        imageUrl: item.imageUrl,
        context: this.createCutoutContext(batch, item),
      });
      const { postProcessError, ...imageResult } = result;
      let mockupResult = {};
      let error = postProcessError || null;
      let mockupStatus = 'success';
      let mockupError = null;
      let mockupAttempts = Number(item.mockupAttempts || 0);

      if (!postProcessError) {
        try {
          mockupAttempts += 1;
          mockupResult = await this.generateMockupResult(batch, imageResult);
        } catch (err) {
          mockupStatus = 'failed';
          mockupError = this.formatDbError(err, '效果图生成失败：');
          error = mockupError;
        }
      } else {
        mockupStatus = 'skipped';
      }

      await this.itemEntity.update(item.id, {
        ...imageResult,
        ...mockupResult,
        status: 'success',
        cutoutStatus: postProcessError ? 'failed' : 'success',
        cutoutAttempts: Number(item.cutoutAttempts || 0) + 1,
        cutoutError: postProcessError || null,
        mockupStatus,
        mockupError,
        mockupAttempts,
        error,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const error = this.formatDbError(err);
      await this.itemEntity.update(item.id, {
        status: 'success',
        cutoutStatus: 'failed',
        cutoutAttempts: Number(item.cutoutAttempts || 0) + 1,
        cutoutError: error,
        error,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      await this.refreshBatchStats(batch.id);
      this.scheduleArtifactWrite(batch.id);
    }
  }

  private async retryMockupFailures(batchId: number) {
    const batch = await this.ensureBatch(batchId);
    const items = await this.itemEntity.find({
      where: {
        batchId,
        status: 'success',
      },
      order: { id: 'ASC' },
    });
    const retryableItems = items.filter(item =>
      this.isMockupRepairableItem(item)
    );

    for (const item of retryableItems) {
      try {
        const mockupResult = await this.generateMockupResult(batch, {
          fileName: item.fileName,
          filePath: item.filePath,
          imageUrl: item.imageUrl,
        });
        await this.itemEntity.update(item.id, {
          ...mockupResult,
          mockupStatus: 'success',
          mockupError: null,
          mockupAttempts: Number(item.mockupAttempts || 0) + 1,
          verifyStatus: 'pending',
          verifyError: null,
        });
      } catch (err) {
        const error = this.formatDbError(err, '效果图生成失败：');
        await this.itemEntity.update(item.id, {
          mockupStatus: 'failed',
          mockupError: error,
          mockupAttempts: Number(item.mockupAttempts || 0) + 1,
          error,
        });
      }
    }
  }

  private isMockupRepairableItem(item: PodGenerationItemEntity) {
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      return false;
    }
    if (item.cutoutStatus === 'failed' || item.cutoutStatus === 'running') {
      return false;
    }
    if (item.mockupStatus === 'failed' || item.mockupStatus === 'pending') {
      return true;
    }
    if (!item.mockupImageUrl || !item.mockupFilePath) {
      return true;
    }
    return !fs.existsSync(item.mockupFilePath);
  }

  private async verifyBatchArtifacts(batchId: number) {
    const items = await this.itemEntity.find({
      where: { batchId },
      order: { id: 'ASC' },
    });
    let failedCount = 0;
    for (const item of items) {
      if (item.status !== 'success') {
        continue;
      }

      const errors: string[] = [];
      const warnings: string[] = [];
      if (!item.filePath || !fs.existsSync(item.filePath)) {
        errors.push('图片文件不存在');
      } else {
        try {
          const stat = await fs.promises.stat(item.filePath);
          if (stat.size <= 1024) {
            errors.push('图片文件过小');
          }
        } catch (err) {
          errors.push(this.formatDbError(err, '图片文件检查失败：'));
        }
      }
      if (item.cutoutStatus === 'success') {
        if (!this.isTransparentPng(item.filePath)) {
          warnings.push('抠图 PNG 未检测到透明通道');
        }
      } else if (item.cutoutStatus === 'failed') {
        warnings.push(item.cutoutError || '抠图失败');
      }
      if (item.mockupStatus === 'success') {
        if (!item.mockupFilePath || !fs.existsSync(item.mockupFilePath)) {
          warnings.push('效果图文件不存在');
        } else {
          try {
            const stat = await fs.promises.stat(item.mockupFilePath);
            if (stat.size <= 1024) {
              warnings.push('效果图文件过小');
            }
          } catch (err) {
            warnings.push(this.formatDbError(err, '效果图文件检查失败：'));
          }
        }
      } else if (item.mockupStatus === 'failed') {
        warnings.push(item.mockupError || '效果图生成失败');
      }

      const verifyStatus = errors.length
        ? 'failed'
        : warnings.length
        ? 'warning'
        : 'ok';
      if (errors.length) {
        failedCount += 1;
      }
      const messages = [...errors, ...warnings];
      await this.itemEntity.update(item.id, {
        verifyStatus,
        verifyError: messages.length
          ? this.formatDbError(messages.join('；'))
          : null,
      });
    }
    return { failedCount };
  }

  private async finishBatch(id: number) {
    // 根据任务项最终统计回写批次状态；仍有运行/待生成任务时不能提前写终态。
    const stats = await this.refreshBatchStats(id);
    const artifactStats = await this.verifyBatchArtifacts(id);
    const pendingCount = await this.itemEntity.countBy({
      batchId: id,
      status: 'pending',
      promptStatus: 'approved',
    });
    const activeCount = await this.countActiveItems(id);
    const postProcessStats = await this.getPostProcessStats(id);
    const status = this.resolveBatchStatus(
      stats,
      pendingCount,
      activeCount,
      artifactStats.failedCount,
      postProcessStats
    );
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
      'cutoutStatus',
      'cutoutError',
      'mockupImageUrl',
      'mockupStatus',
      'mockupAttempts',
      'mockupError',
      'mockupFileName',
      'verifyStatus',
      'verifyError',
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
        item.cutoutStatus || '',
        item.cutoutError || '',
        item.mockupImageUrl || '',
        item.mockupStatus || '',
        item.mockupAttempts || 0,
        item.mockupError || '',
        item.mockupFileName || '',
        item.verifyStatus || '',
        item.verifyError || '',
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
    const artifactStats = await this.verifyBatchArtifacts(id);
    const pendingCount = await this.itemEntity.countBy({
      batchId: id,
      status: 'pending',
      promptStatus: 'approved',
    });
    const activeCount = await this.countActiveItems(id);
    const postProcessStats = await this.getPostProcessStats(id);
    const status = this.resolveBatchStatus(
      stats,
      pendingCount,
      activeCount,
      artifactStats.failedCount,
      postProcessStats
    );
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
    activeCount: number,
    artifactFailedCount = 0,
    postProcessStats: PostProcessStats = this.emptyPostProcessStats()
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
    if (this.hasPostProcessIssues(postProcessStats)) {
      return 'partial_failed';
    }
    return stats.failedCount === 0 && artifactFailedCount === 0
      ? 'completed'
      : stats.successCount > 0
      ? 'partial_failed'
      : 'failed';
  }

  private async resolveImportRowStatusFromBatch(batch: any) {
    if (!this.isBatchTerminalSuccess(batch.status)) {
      return 'failed';
    }
    const postProcessStats = await this.getPostProcessStats(batch.id);
    return this.hasPostProcessIssues(postProcessStats)
      ? 'post_processing'
      : 'completed';
  }

  private async resolveImportRowErrorFromBatch(batch: any) {
    if (!this.isBatchTerminalSuccess(batch.status)) {
      return batch.error || `批次状态：${batch.status}`;
    }
    const messages = this.formatPostProcessIssues(
      await this.getPostProcessStats(batch.id)
    );
    return messages.length ? messages.join('；') : null;
  }

  private emptyPostProcessStats(): PostProcessStats {
    return {
      cutoutFailedCount: 0,
      cutoutPendingCount: 0,
      mockupFailedCount: 0,
      mockupMissingCount: 0,
      verifyFailedCount: 0,
    };
  }

  private hasPostProcessIssues(stats: PostProcessStats) {
    return (
      stats.cutoutFailedCount > 0 ||
      stats.cutoutPendingCount > 0 ||
      stats.mockupFailedCount > 0 ||
      stats.mockupMissingCount > 0 ||
      stats.verifyFailedCount > 0
    );
  }

  private formatPostProcessIssues(stats: PostProcessStats) {
    const messages = [];
    if (stats.cutoutFailedCount) {
      messages.push(`抠图失败 ${stats.cutoutFailedCount}`);
    }
    if (stats.cutoutPendingCount) {
      messages.push(`抠图未完成 ${stats.cutoutPendingCount}`);
    }
    if (stats.mockupFailedCount) {
      messages.push(`效果图失败 ${stats.mockupFailedCount}`);
    }
    if (stats.mockupMissingCount) {
      messages.push(`效果图缺失 ${stats.mockupMissingCount}`);
    }
    if (stats.verifyFailedCount) {
      messages.push(`检查失败 ${stats.verifyFailedCount}`);
    }
    return messages;
  }

  private async getPostProcessStats(batchId: number) {
    const items = await this.itemEntity.find({
      where: { batchId, status: 'success' },
      order: { id: 'ASC' },
    });
    const stats = this.emptyPostProcessStats();
    for (const item of items) {
      if (item.cutoutStatus === 'failed') {
        stats.cutoutFailedCount += 1;
      } else if (
        item.cutoutStatus === 'pending' ||
        item.cutoutStatus === 'running'
      ) {
        stats.cutoutPendingCount += 1;
      }

      if (item.mockupStatus === 'failed') {
        stats.mockupFailedCount += 1;
      } else if (this.isMockupMissingItem(item)) {
        stats.mockupMissingCount += 1;
      }

      if (item.verifyStatus === 'failed') {
        stats.verifyFailedCount += 1;
      }
    }
    return stats;
  }

  private isMockupMissingItem(item: PodGenerationItemEntity) {
    if (item.cutoutStatus === 'failed' || item.cutoutStatus === 'running') {
      return false;
    }
    if (item.mockupStatus === 'failed') {
      return false;
    }
    if (item.mockupStatus === 'pending') {
      return true;
    }
    if (!item.mockupImageUrl || !item.mockupFilePath) {
      return true;
    }
    return !fs.existsSync(item.mockupFilePath);
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

  private createCutoutContext(
    batch: PodGenerationBatchEntity,
    item: PodGenerationItemEntity
  ) {
    return {
      batchId: batch.id,
      batchNo: batch.batchNo,
      itemId: item.id,
      itemNo: item.itemNo,
      fileName: item.fileName || this.getImageFileBaseName(item),
    };
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

  private createImportNo() {
    return `${moment().format('YYYYMMDD-HHmmss')}-${uuidv4().slice(0, 6)}`;
  }

  private isBatchTerminalSuccess(status: string) {
    return status === 'completed';
  }

  private async refreshImportStats(importId: number) {
    const rows = await this.importRowEntity.find({ where: { importId } });
    if (!rows.length) {
      return;
    }
    const successRows = rows.filter(row =>
      ['completed', 'created'].includes(row.status)
    ).length;
    const failedRows = rows.filter(row => row.status === 'failed').length;
    const activeRows = rows.filter(row =>
      [
        'pending',
        'creating_batch',
        'prompt_generating',
        'image_generating',
        'post_processing',
        'verifying',
      ].includes(row.status)
    ).length;
    const totalImages = rows.reduce(
      (sum, row) =>
        sum + (row.topic && row.count > 0 ? Number(row.count || 0) : 0),
      0
    );
    let status = 'running';
    if (!activeRows) {
      status =
        failedRows === 0
          ? 'completed'
          : successRows > 0
          ? 'partial_failed'
          : 'failed';
    }
    await this.importEntity.update(importId, {
      totalRows: rows.length,
      successRows,
      failedRows,
      totalImages,
      status,
      error: failedRows ? `${failedRows} 行导入失败` : null,
    });
  }

  private isTransparentPng(filePath: string) {
    try {
      if (!filePath || path.extname(filePath).toLowerCase() !== '.png') {
        return false;
      }
      const buffer = fs.readFileSync(filePath);
      const pngSignature = '89504e470d0a1a0a';
      if (
        buffer.length < 33 ||
        buffer.slice(0, 8).toString('hex') !== pngSignature
      ) {
        return false;
      }
      const colorType = buffer[25];
      if (colorType === 4 || colorType === 6) {
        return true;
      }
      return buffer.includes(Buffer.from('tRNS'));
    } catch {
      return false;
    }
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
