import { Init, Inject, Provide } from '@midwayjs/core';
import { BaseService, CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import { PodGenerationImportEntity } from '../entity/import';
import { PodGenerationImportRowEntity } from '../entity/import-row';
import { PodGenerationBatchEntity } from '../entity/batch';
import { PodGenerationItemEntity } from '../entity/item';
import { PodGenerationService } from './generation';
import { isStaleTime, resolvePostProcessStaleMinutes } from '../utils/stale';

/**
 * POD表格导入记录
 */
@Provide()
export class PodGenerationImportService extends BaseService {
  @InjectEntityModel(PodGenerationImportEntity)
  importEntity: Repository<PodGenerationImportEntity>;

  @InjectEntityModel(PodGenerationImportRowEntity)
  rowEntity: Repository<PodGenerationImportRowEntity>;

  @InjectEntityModel(PodGenerationBatchEntity)
  batchEntity: Repository<PodGenerationBatchEntity>;

  @InjectEntityModel(PodGenerationItemEntity)
  itemEntity: Repository<PodGenerationItemEntity>;

  @Inject()
  podGenerationService: PodGenerationService;

  @Init()
  async init() {
    await super.init();
    this.setEntity(this.importEntity);
  }

  async delete(ids: any) {
    const idArr = (Array.isArray(ids) ? ids : String(ids).split(','))
      .map(id => Number(id))
      .filter(Boolean);
    if (!idArr.length) {
      return;
    }

    await this.importEntity.manager.transaction(async manager => {
      await manager.delete(PodGenerationImportRowEntity, {
        importId: In(idArr),
      });
      await manager.delete(PodGenerationImportEntity, { id: In(idArr) });
    });
  }

  async detail(id: number) {
    const record = await this.importEntity.findOneBy({ id: Number(id) });
    if (!record) {
      throw new CoolCommException('导入记录不存在');
    }
    const rows = await this.rowEntity.find({
      where: { importId: record.id },
      order: { rowNo: 'ASC', id: 'ASC' },
    });
    return {
      ...record,
      rows: await this.attachBatchProgress(rows),
    };
  }

  async rows(query: any) {
    const importId = Number(query.importId || 0);
    if (!importId) {
      throw new CoolCommException('请选择导入记录');
    }
    const page = this.clamp(Number(query.page || 1), 1, 100000);
    const size = this.clamp(Number(query.size || 20), 1, 100);
    const find = this.rowEntity
      .createQueryBuilder('a')
      .where('a.importId = :importId', { importId });
    if (query.status) {
      find.andWhere('a.status = :status', { status: query.status });
    }
    if (query.keyWord) {
      find.andWhere(
        '(a.topic like :keyWord or a.batchNo like :keyWord or a.error like :keyWord)',
        { keyWord: `%${query.keyWord}%` }
      );
    }
    const [list, total] = await find
      .orderBy('a.rowNo', 'ASC')
      .addOrderBy('a.id', 'ASC')
      .skip((page - 1) * size)
      .take(size)
      .getManyAndCount();
    return {
      list: await this.attachBatchProgress(list),
      pagination: {
        page,
        size,
        total,
      },
    };
  }

  async queueStats(id: number) {
    const importId = Number(id);
    const record = await this.importEntity.findOneBy({ id: importId });
    if (!record) {
      throw new CoolCommException('导入记录不存在');
    }

    const rows = await this.rowEntity.find({
      where: { importId },
      order: { rowNo: 'ASC', id: 'ASC' },
    });
    const batchIds = rows.map(row => row.batchId).filter(Boolean);
    const [batches, items] = batchIds.length
      ? await Promise.all([
          this.batchEntity.find({
            where: { id: In(batchIds) },
            order: { id: 'ASC' },
          }),
          this.itemEntity.find({
            where: { batchId: In(batchIds) },
            order: { updateTime: 'DESC', id: 'ASC' },
          }),
        ])
      : [[], []];
    const batchMap = new Map(batches.map(batch => [batch.id, batch]));
    const rowMap = new Map(rows.map(row => [row.batchId, row]));
    const staleMinutes = resolvePostProcessStaleMinutes();

    return {
      importId: record.id,
      importNo: record.importNo,
      fileName: record.fileName,
      status: record.status,
      staleMinutes,
      queues: [
        this.buildImportPromptQueue(rows, batches),
        this.buildImageQueue(items, batchMap, rowMap, staleMinutes),
        this.buildCutoutQueue(items, batchMap, rowMap, staleMinutes),
        this.buildMockupQueue(items, batchMap, rowMap, staleMinutes),
      ],
    };
  }

  private clamp(value: number, min: number, max: number) {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  private async attachBatchProgress(rows: PodGenerationImportRowEntity[]) {
    const batchIds = rows.map(row => row.batchId).filter(Boolean);
    if (!batchIds.length) {
      return rows;
    }

    const [batches, items] = await Promise.all([
      this.batchEntity.find({
        where: { id: In(batchIds) },
      }),
      this.itemEntity.find({
        where: { batchId: In(batchIds) },
        order: { batchId: 'ASC', id: 'ASC' },
      }),
    ]);
    const batchMap = new Map(batches.map(batch => [batch.id, batch]));
    const progressMap = new Map<number, any>();
    for (const item of items) {
      const progress = progressMap.get(item.batchId) || {
        successCount: 0,
        failedCount: 0,
        cutoutFailedCount: 0,
        cutoutPendingCount: 0,
        mockupFailedCount: 0,
        mockupMissingCount: 0,
        verifyFailedCount: 0,
      };
      if (item.status === 'success') {
        progress.successCount += 1;
        if (item.cutoutStatus === 'failed') {
          progress.cutoutFailedCount += 1;
        } else if (
          item.cutoutStatus === 'pending' ||
          item.cutoutStatus === 'running'
        ) {
          progress.cutoutPendingCount += 1;
        }
        if (item.mockupStatus === 'failed') {
          progress.mockupFailedCount += 1;
        } else if (this.isMockupMissingItem(item)) {
          progress.mockupMissingCount += 1;
        }
        if (item.verifyStatus === 'failed') {
          progress.verifyFailedCount += 1;
        }
      } else if (item.status === 'failed') {
        progress.failedCount += 1;
      }
      progressMap.set(item.batchId, progress);
    }

    return rows.map(row => {
      const batch = batchMap.get(row.batchId);
      const progress = progressMap.get(row.batchId);
      const hasPostProcessIssues = Boolean(
        progress &&
          (progress.cutoutFailedCount ||
            progress.cutoutPendingCount ||
            progress.mockupFailedCount ||
            progress.mockupMissingCount ||
            progress.verifyFailedCount)
      );
      const batchStatus =
        batch?.status === 'completed' && hasPostProcessIssues
          ? 'partial_failed'
          : batch?.status || '';
      return {
        ...row,
        status:
          row.status === 'completed' && hasPostProcessIssues
            ? 'post_processing'
            : row.status,
        batchStatus,
        batchCount: batch?.count || row.count || 0,
        batchSuccessCount: progress?.successCount || 0,
        batchFailedCount: progress?.failedCount || 0,
        cutoutFailedCount: progress?.cutoutFailedCount || 0,
        cutoutPendingCount: progress?.cutoutPendingCount || 0,
        mockupFailedCount: progress?.mockupFailedCount || 0,
        mockupMissingCount: progress?.mockupMissingCount || 0,
        verifyFailedCount: progress?.verifyFailedCount || 0,
      };
    });
  }

  private buildImportPromptQueue(
    rows: PodGenerationImportRowEntity[],
    batches: PodGenerationBatchEntity[]
  ) {
    const runningStatuses = ['creating_batch', 'prompt_generating'];
    const pendingStatuses = ['pending'];
    const successStatuses = [
      'created',
      'image_generating',
      'post_processing',
      'verifying',
      'completed',
    ];
    const failedStatuses = ['failed'];
    const statusCounts = this.countBy(rows, row => row.status || 'pending');
    const promptStatusCounts = this.countBy(
      batches,
      batch => batch.status || 'pending'
    );
    const watchRowCandidates = rows
      .filter(
        row =>
          runningStatuses.includes(row.status) ||
          failedStatuses.includes(row.status) ||
          pendingStatuses.includes(row.status)
      )
      .map(row => this.buildImportPromptQueueItem(row));
    // blocked 总数统计全量候选，不受展示前 20 条截断影响。
    const blockedCount = watchRowCandidates.filter(row => row.blocked).length;
    const watchRows = watchRowCandidates.slice(0, 20);

    return {
      key: 'importPrompt',
      name: '导入 / Prompt',
      totalHint: '导入行总数，后续阶段中的行表示已越过 Prompt 阶段',
      total: rows.length,
      pending: this.sumStatus(statusCounts, pendingStatuses),
      running: this.sumStatus(statusCounts, runningStatuses),
      success: this.sumStatus(statusCounts, successStatuses),
      failed: this.sumStatus(statusCounts, failedStatuses),
      skipped: 0,
      stale: 0,
      blocked: blockedCount,
      statuses: {
        ...statusCounts,
        prompt_generating_batches: promptStatusCounts.prompt_generating || 0,
        prompt_ready_batches: promptStatusCounts.prompt_ready || 0,
      },
      items: watchRows,
    };
  }

  private buildImageQueue(
    items: PodGenerationItemEntity[],
    batchMap: Map<number, PodGenerationBatchEntity>,
    rowMap: Map<number, PodGenerationImportRowEntity>,
    staleMinutes: number
  ) {
    const statusCounts = this.countBy(items, item => item.status || 'pending');
    const staleItems = items.filter(
      item =>
        item.status === 'running' && isStaleTime(item.updateTime, staleMinutes)
    );
    const { items: queueItems, blocked } = this.pickQueueItems(
      items,
      item => ['running', 'failed', 'pending'].includes(item.status),
      item => item.status,
      batchMap,
      rowMap,
      staleMinutes,
      'image'
    );
    return {
      key: 'image',
      name: '生图队列',
      totalHint: '已创建的图片任务总数',
      total: items.length,
      pending: statusCounts.pending || 0,
      running: statusCounts.running || 0,
      success: statusCounts.success || 0,
      failed: statusCounts.failed || 0,
      skipped: 0,
      stale: staleItems.length,
      blocked,
      statuses: statusCounts,
      items: queueItems,
    };
  }

  private buildCutoutQueue(
    items: PodGenerationItemEntity[],
    batchMap: Map<number, PodGenerationBatchEntity>,
    rowMap: Map<number, PodGenerationImportRowEntity>,
    staleMinutes: number
  ) {
    const cutoutItems = items.filter(item => item.status === 'success');
    const statusCounts = this.countBy(
      cutoutItems,
      item => item.cutoutStatus || 'pending'
    );
    const staleItems = cutoutItems.filter(
      item =>
        item.cutoutStatus === 'running' &&
        isStaleTime(item.updateTime, staleMinutes)
    );
    const { items: queueItems, blocked } = this.pickQueueItems(
      cutoutItems,
      item => ['running', 'failed', 'pending'].includes(item.cutoutStatus),
      item => item.cutoutStatus,
      batchMap,
      rowMap,
      staleMinutes,
      'cutout'
    );
    return {
      key: 'cutout',
      name: '抠图队列',
      totalHint: '已完成生图并进入抠图判断范围的图片数',
      total: cutoutItems.length,
      pending: statusCounts.pending || 0,
      running: statusCounts.running || 0,
      success: statusCounts.success || 0,
      failed: statusCounts.failed || 0,
      skipped: statusCounts.skipped || 0,
      stale: staleItems.length,
      blocked,
      statuses: statusCounts,
      items: queueItems,
    };
  }

  private buildMockupQueue(
    items: PodGenerationItemEntity[],
    batchMap: Map<number, PodGenerationBatchEntity>,
    rowMap: Map<number, PodGenerationImportRowEntity>,
    staleMinutes: number
  ) {
    const mockupItems = items.filter(item => item.status === 'success');
    const waitingCutoutItems = mockupItems.filter(item =>
      this.isWaitingCutoutForMockup(item)
    );
    const queueItems = mockupItems.filter(
      item =>
        this.isWaitingCutoutForMockup(item) ||
        ['running', 'failed', 'pending'].includes(item.mockupStatus) ||
        this.isMockupMissingItem(item)
    );
    const completedItems = mockupItems.filter(
      item =>
        ['success', 'skipped'].includes(item.cutoutStatus) &&
        item.mockupStatus === 'success' &&
        !this.isMockupMissingItem(item)
    );
    const skippedItems = mockupItems.filter(
      item => item.mockupStatus === 'skipped'
    );
    const statusCounts = this.countBy(queueItems, item =>
      this.getMockupQueueStatus(item)
    );
    const staleItems = queueItems.filter(
      item =>
        item.mockupStatus === 'running' &&
        isStaleTime(item.updateTime, staleMinutes)
    );
    const mockupItemsResult = this.pickQueueItems(
      queueItems,
      item =>
        ['running', 'failed', 'pending'].includes(
          this.getMockupQueueStatus(item)
        ),
      item => this.getMockupQueueStatus(item),
      batchMap,
      rowMap,
      staleMinutes,
      'mockup'
    );
    return {
      key: 'mockup',
      name: '效果图队列',
      totalHint: '当前仍需等待抠图、生成效果图或修复效果图的图片数',
      total: queueItems.length,
      pending: statusCounts.pending || 0,
      running: statusCounts.running || 0,
      success: completedItems.length,
      failed: statusCounts.failed || 0,
      skipped: skippedItems.length,
      waitingCutout: waitingCutoutItems.length,
      stale: staleItems.length,
      blocked: mockupItemsResult.blocked,
      statuses: {
        ...statusCounts,
        completed: completedItems.length,
        skipped: skippedItems.length,
        waiting_cutout: waitingCutoutItems.length,
      },
      items: mockupItemsResult.items,
    };
  }

  private isWaitingCutoutForMockup(item: PodGenerationItemEntity) {
    return (
      !['success', 'skipped'].includes(item.cutoutStatus) &&
      item.mockupStatus !== 'success' &&
      item.mockupStatus !== 'failed'
    );
  }

  private getMockupQueueStatus(item: PodGenerationItemEntity) {
    if (this.isWaitingCutoutForMockup(item)) {
      return 'pending';
    }
    if (this.isMockupMissingItem(item) && item.mockupStatus === 'success') {
      return 'pending';
    }
    return item.mockupStatus || 'pending';
  }

  private pickQueueItems(
    items: PodGenerationItemEntity[],
    predicate: (item: PodGenerationItemEntity) => boolean,
    statusGetter: (item: PodGenerationItemEntity) => string,
    batchMap: Map<number, PodGenerationBatchEntity>,
    rowMap: Map<number, PodGenerationImportRowEntity>,
    staleMinutes: number,
    queueKey: 'image' | 'cutout' | 'mockup'
  ) {
    const priority = {
      running: 1,
      failed: 2,
      pending: 3,
    } as Record<string, number>;
    const mapped = items
      .filter(predicate)
      .sort((a, b) => {
        const statusA = statusGetter(a) || '';
        const statusB = statusGetter(b) || '';
        return (
          (priority[statusA] || 99) - (priority[statusB] || 99) || a.id - b.id
        );
      })
      .map(item => {
        const batch = batchMap.get(item.batchId);
        const row = rowMap.get(item.batchId);
        const status = statusGetter(item) || 'pending';
        const repair = this.resolveItemRepairMeta(item, queueKey, batch?.id);
        return {
          id: item.id,
          rowNo: row?.rowNo || null,
          batchId: item.batchId,
          batchNo: batch?.batchNo || row?.batchNo || '',
          itemNo: item.itemNo,
          topic: batch?.topic || row?.topic || '',
          status,
          stale:
            status === 'running' && isStaleTime(item.updateTime, staleMinutes),
          updateTime: item.updateTime,
          error: item.error || item.cutoutError || item.mockupError || '',
          imageStatus: item.status,
          promptStatus: item.promptStatus,
          cutoutStatus: item.cutoutStatus,
          mockupStatus: item.mockupStatus,
          ...repair,
        };
      });
    // blocked 总数统计全量候选，不受展示前 20 条截断影响。
    const blocked = mapped.filter(item => item.blocked).length;
    return {
      items: mapped.slice(0, 20),
      blocked,
    };
  }

  private countBy<T>(items: T[], getter: (item: T) => string) {
    return items.reduce((map, item) => {
      const key = getter(item);
      map[key] = (map[key] || 0) + 1;
      return map;
    }, {} as Record<string, number>);
  }

  private sumStatus(counts: Record<string, number>, statuses: string[]) {
    return statuses.reduce(
      (sum, status) => sum + Number(counts[status] || 0),
      0
    );
  }

  /**
   * 导入行级队列项构造（importPrompt 队列）。
   * 只有失败/待处理且无批次冲突的行才可修复；批次主图运行中时阻塞。
   */
  private buildImportPromptQueueItem(row: PodGenerationImportRowEntity) {
    const failed = row.status === 'failed';
    const pending = row.status === 'pending';
    const repairable = failed || pending;
    let blocked = false;
    let blockReason = '';
    if (
      row.batchId &&
      this.podGenerationService.isBatchMainImageRunning(row.batchId)
    ) {
      blocked = true;
      blockReason = '当前批次正在生成中，请稍后修复';
    }
    return {
      id: row.id,
      rowNo: row.rowNo,
      batchId: row.batchId,
      batchNo: row.batchNo,
      topic: row.topic,
      status: row.status,
      updateTime: row.updateTime,
      error: row.error,
      repairable: repairable && !blocked,
      blocked,
      blockReason,
      repairAction: 'repairImportRow',
      repairTargetType: 'row' as const,
      repairTargetId: row.id,
    };
  }

  /**
   * 计算 image / cutout / mockup 队列项的修复元数据。
   * 规则与 generation.ts 中 retryItem / cutoutItem / generateMockupItem 的执行前置条件保持一致，
   * 前序依赖未满足时只标记阻塞，不自动跨阶段触发。
   */
  private resolveItemRepairMeta(
    item: PodGenerationItemEntity,
    queueKey: 'image' | 'cutout' | 'mockup',
    batchId?: number
  ): QueueRepairMeta {
    if (queueKey === 'image') {
      // 生图修复：要求 status=failed 且 promptStatus=approved，且批次未在生图。
      if (item.status !== 'failed') {
        return {
          repairable: false,
          blocked: false,
          blockReason: '',
          repairAction: 'retryItem',
          repairTargetType: 'item',
          repairTargetId: item.id,
        };
      }
      if (item.promptStatus !== 'approved') {
        return {
          repairable: false,
          blocked: true,
          blockReason: '提示词未确认，需先确认提示词',
          repairAction: 'retryItem',
          repairTargetType: 'item',
          repairTargetId: item.id,
        };
      }
      if (
        batchId &&
        this.podGenerationService.isBatchMainImageRunning(batchId)
      ) {
        return {
          repairable: false,
          blocked: true,
          blockReason: '当前批次正在生成中，请稍后修复',
          repairAction: 'retryItem',
          repairTargetType: 'item',
          repairTargetId: item.id,
        };
      }
      return {
        repairable: true,
        blocked: false,
        blockReason: '',
        repairAction: 'retryItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }

    if (queueKey === 'cutout') {
      // 抠图修复：要求生图成功且本地图片文件存在，且当前未在抠图。
      if (item.cutoutStatus === 'running') {
        return {
          repairable: false,
          blocked: true,
          blockReason: '当前图片正在抠图中',
          repairAction: 'cutoutItem',
          repairTargetType: 'item',
          repairTargetId: item.id,
        };
      }
      if (item.status !== 'success') {
        return {
          repairable: false,
          blocked: true,
          blockReason: '需先在生图队列修复',
          repairAction: 'cutoutItem',
          repairTargetType: 'item',
          repairTargetId: item.id,
        };
      }
      if (!item.filePath || !fs.existsSync(item.filePath)) {
        return {
          repairable: false,
          blocked: true,
          blockReason: '当前图片文件不存在，请先重新生成',
          repairAction: 'cutoutItem',
          repairTargetType: 'item',
          repairTargetId: item.id,
        };
      }
      if (item.cutoutStatus !== 'failed' && item.cutoutStatus !== 'pending') {
        // success / skipped：列表理论上不会展示，防御性处理。
        return {
          repairable: false,
          blocked: false,
          blockReason: '',
          repairAction: 'cutoutItem',
          repairTargetType: 'item',
          repairTargetId: item.id,
        };
      }
      return {
        repairable: true,
        blocked: false,
        blockReason: '',
        repairAction: 'cutoutItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }

    // mockup 修复：要求生图成功、抠图 success/skipped、图片文件存在。
    if (item.mockupStatus === 'running') {
      return {
        repairable: false,
        blocked: true,
        blockReason: '当前图片正在生成效果图',
        repairAction: 'generateMockupItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }
    if (item.status !== 'success') {
      return {
        repairable: false,
        blocked: true,
        blockReason: '需先在生图队列修复',
        repairAction: 'generateMockupItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }
    if (item.cutoutStatus === 'failed') {
      return {
        repairable: false,
        blocked: true,
        blockReason: '需先在抠图队列修复',
        repairAction: 'generateMockupItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }
    if (item.cutoutStatus === 'running') {
      return {
        repairable: false,
        blocked: true,
        blockReason: '抠图处理中，请稍后再修复效果图',
        repairAction: 'generateMockupItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }
    if (item.cutoutStatus !== 'success' && item.cutoutStatus !== 'skipped') {
      // pending 等其它状态：抠图尚未完成，必须等待。
      return {
        repairable: false,
        blocked: true,
        blockReason: '抠图未完成，请等待抠图结束后再修复效果图',
        repairAction: 'generateMockupItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      return {
        repairable: false,
        blocked: true,
        blockReason: '当前图片文件不存在，请先重新生成',
        repairAction: 'generateMockupItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }
    if (!this.isMockupMissingItem(item) && item.mockupStatus !== 'failed') {
      // 已成功且文件存在：列表理论上不会展示，防御性处理。
      return {
        repairable: false,
        blocked: false,
        blockReason: '',
        repairAction: 'generateMockupItem',
        repairTargetType: 'item',
        repairTargetId: item.id,
      };
    }
    return {
      repairable: true,
      blocked: false,
      blockReason: '',
      repairAction: 'generateMockupItem',
      repairTargetType: 'item',
      repairTargetId: item.id,
    };
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

  /**
   * 单项队列修复：按 queueKey 分发到已有能力，执行前再做一次阻塞兜底校验。
   * 复用 PodGenerationService，不重写状态机。
   */
  async repairQueueItem(params: {
    importId: number;
    queueKey: string;
    targetId: number;
    targetType: 'row' | 'item';
  }) {
    const importId = Number(params?.importId);
    const targetId = Number(params?.targetId);
    const queueKey = String(params?.queueKey || '');
    const targetType = String(params?.targetType || 'item');
    if (!importId || !Number.isFinite(importId)) {
      throw new CoolCommException('缺少参数 importId');
    }
    if (!targetId || !Number.isFinite(targetId)) {
      throw new CoolCommException('缺少参数 targetId');
    }
    if (!['importPrompt', 'image', 'cutout', 'mockup'].includes(queueKey)) {
      throw new CoolCommException('队列类型不合法');
    }
    if (!['row', 'item'].includes(targetType)) {
      throw new CoolCommException('修复目标类型不合法');
    }

    if (queueKey === 'importPrompt') {
      return this.repairImportPromptQueueItem(importId, targetId);
    }
    return this.repairItemQueueItem(
      importId,
      queueKey as 'image' | 'cutout' | 'mockup',
      targetId
    );
  }

  private async repairImportPromptQueueItem(importId: number, rowId: number) {
    const row = await this.rowEntity.findOneBy({ id: rowId });
    if (!row || row.importId !== importId) {
      throw new CoolCommException('导入行不存在或不属于当前导入记录');
    }
    if (
      row.batchId &&
      this.podGenerationService.isBatchMainImageRunning(row.batchId)
    ) {
      throw new CoolCommException('当前批次正在生成中，请稍后修复');
    }
    const updated = await this.podGenerationService.repairImportRow(rowId);
    return {
      importId,
      queueKey: 'importPrompt',
      targetType: 'row' as const,
      targetId: rowId,
      rowNo: row.rowNo,
      status: 'repaired',
      item: updated,
    };
  }

  private async repairItemQueueItem(
    importId: number,
    queueKey: 'image' | 'cutout' | 'mockup',
    itemId: number
  ) {
    const item = await this.itemEntity.findOneBy({ id: itemId });
    if (!item) {
      throw new CoolCommException('任务项不存在');
    }
    const belong = await this.assertItemBelongsToImport(item, importId);
    const meta = this.resolveItemRepairMeta(item, queueKey, item.batchId);
    if (meta.blocked) {
      return {
        importId,
        queueKey,
        targetType: 'item' as const,
        targetId: itemId,
        rowNo: belong.rowNo,
        itemNo: item.itemNo,
        status: 'blocked',
        message: meta.blockReason,
      };
    }
    if (!meta.repairable) {
      return {
        importId,
        queueKey,
        targetType: 'item' as const,
        targetId: itemId,
        rowNo: belong.rowNo,
        itemNo: item.itemNo,
        status: 'skipped',
        message: '当前状态无需修复',
      };
    }

    const result = await this.dispatchItemRepair(queueKey, itemId);
    return {
      importId,
      queueKey,
      targetType: 'item' as const,
      targetId: itemId,
      rowNo: belong.rowNo,
      itemNo: item.itemNo,
      status: 'repaired',
      item: result,
    };
  }

  /**
   * 批量队列修复：按 importId + queueKey 直接查询数据库全部候选失败项，
   * 不依赖 queueStats().items（避免 20 条截断）。
   * 顺序执行可修复项，单个失败不影响后续；阻塞项跳过并记录原因。
   */
  async repairQueue(params: { importId: number; queueKey: string }) {
    const importId = Number(params?.importId);
    const queueKey = String(params?.queueKey || '');
    if (!importId || !Number.isFinite(importId)) {
      throw new CoolCommException('缺少参数 importId');
    }
    if (!['importPrompt', 'image', 'cutout', 'mockup'].includes(queueKey)) {
      throw new CoolCommException('队列类型不合法');
    }

    const candidates = await this.collectQueueRepairCandidates(
      importId,
      queueKey as QueueKey
    );

    const results: any[] = [];
    let repaired = 0;
    let blocked = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        const meta = candidate.meta;
        if (meta.blocked) {
          blocked += 1;
          results.push({
            targetType: candidate.targetType,
            targetId: candidate.targetId,
            rowNo: candidate.rowNo,
            itemNo: candidate.itemNo,
            status: 'blocked',
            message: meta.blockReason,
          });
          continue;
        }
        if (!meta.repairable) {
          results.push({
            targetType: candidate.targetType,
            targetId: candidate.targetId,
            rowNo: candidate.rowNo,
            itemNo: candidate.itemNo,
            status: 'skipped',
            message: '当前状态无需修复',
          });
          continue;
        }
        await this.dispatchCandidateRepair(candidate);
        repaired += 1;
        results.push({
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          rowNo: candidate.rowNo,
          itemNo: candidate.itemNo,
          status: 'repaired',
        });
      } catch (err: any) {
        failed += 1;
        results.push({
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          rowNo: candidate.rowNo,
          itemNo: candidate.itemNo,
          status: 'failed',
          message: this.compactError(err),
        });
      }
    }

    return {
      importId,
      queueKey,
      total: candidates.length,
      repaired,
      blocked,
      failed,
      results,
    };
  }

  private async collectQueueRepairCandidates(
    importId: number,
    queueKey: QueueKey
  ): Promise<QueueRepairCandidate[]> {
    const rows = await this.rowEntity.find({
      where: { importId },
      order: { rowNo: 'ASC', id: 'ASC' },
    });
    const batchIds = rows.map(row => row.batchId).filter(Boolean);
    const rowByBatchMap = new Map(rows.map(row => [row.batchId, row]));

    if (queueKey === 'importPrompt') {
      const candidates: QueueRepairCandidate[] = [];
      for (const row of rows) {
        if (row.status !== 'failed') {
          // 批量修复仅收 failed 项；pending 属于正常等待，应走"继续执行"语义。
          continue;
        }
        const meta = this.buildImportPromptQueueItem(row);
        candidates.push({
          queueKey,
          targetType: 'row',
          targetId: row.id,
          rowNo: row.rowNo,
          itemNo: null,
          meta,
        });
      }
      return candidates;
    }

    const items = batchIds.length
      ? await this.itemEntity.find({
          where: { batchId: In(batchIds) },
          order: { id: 'ASC' },
        })
      : [];

    return items
      .filter(item => {
        if (queueKey === 'image') {
          return item.status === 'failed';
        }
        if (queueKey === 'cutout') {
          return item.status === 'success' && item.cutoutStatus === 'failed';
        }
        // mockup
        return (
          item.status === 'success' &&
          (item.mockupStatus === 'failed' || this.isMockupMissingItem(item)) &&
          !this.isWaitingCutoutForMockup(item)
        );
      })
      .map(item => {
        const row = rowByBatchMap.get(item.batchId);
        const meta = this.resolveItemRepairMeta(item, queueKey, item.batchId);
        return {
          queueKey,
          targetType: 'item' as const,
          targetId: item.id,
          rowNo: row?.rowNo || null,
          itemNo: item.itemNo,
          meta,
        };
      });
  }

  private async assertItemBelongsToImport(
    item: PodGenerationItemEntity,
    importId: number
  ) {
    const row = await this.rowEntity.findOneBy({ batchId: item.batchId });
    if (!row || row.importId !== importId) {
      throw new CoolCommException('任务项不属于当前导入记录');
    }
    return { rowNo: row.rowNo };
  }

  private async dispatchItemRepair(
    queueKey: 'image' | 'cutout' | 'mockup',
    itemId: number
  ) {
    if (queueKey === 'image') {
      return this.podGenerationService.retryItem(itemId);
    }
    if (queueKey === 'cutout') {
      return this.podGenerationService.cutoutItem(itemId);
    }
    return this.podGenerationService.generateMockupItem(itemId);
  }

  private async dispatchCandidateRepair(candidate: QueueRepairCandidate) {
    if (candidate.targetType === 'row') {
      return this.podGenerationService.repairImportRow(candidate.targetId);
    }
    return this.dispatchItemRepair(
      candidate.queueKey as 'image' | 'cutout' | 'mockup',
      candidate.targetId
    );
  }

  private compactError(err: any) {
    const raw = err?.message || String(err || '未知错误');
    const compact = String(raw).replace(/\s+/g, ' ').trim();
    return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
  }
}

type QueueKey = 'importPrompt' | 'image' | 'cutout' | 'mockup';

interface QueueRepairMeta {
  repairable: boolean;
  blocked: boolean;
  blockReason: string;
  repairAction: string;
  repairTargetType: 'row' | 'item';
  repairTargetId: number;
}

interface QueueRepairCandidate {
  queueKey: QueueKey;
  targetType: 'row' | 'item';
  targetId: number;
  rowNo: number | null;
  itemNo: string | null;
  meta: QueueRepairMeta;
}
