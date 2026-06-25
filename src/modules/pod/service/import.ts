import { Init, Provide } from '@midwayjs/core';
import { BaseService, CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import { PodGenerationImportEntity } from '../entity/import';
import { PodGenerationImportRowEntity } from '../entity/import-row';
import { PodGenerationBatchEntity } from '../entity/batch';
import { PodGenerationItemEntity } from '../entity/item';
import {
  isStaleTime,
  resolvePostProcessStaleMinutes,
} from '../utils/stale';

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
      this.itemEntity
        .find({
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
    const watchRows = rows
      .filter(
        row =>
          runningStatuses.includes(row.status) ||
          failedStatuses.includes(row.status) ||
          pendingStatuses.includes(row.status)
      )
      .slice(0, 20)
      .map(row => ({
        id: row.id,
        rowNo: row.rowNo,
        batchId: row.batchId,
        batchNo: row.batchNo,
        topic: row.topic,
        status: row.status,
        updateTime: row.updateTime,
        error: row.error,
      }));

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
        item.status === 'running' &&
        isStaleTime(item.updateTime, staleMinutes)
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
      statuses: statusCounts,
      items: this.pickQueueItems(
        items,
        item => ['running', 'failed', 'pending'].includes(item.status),
        item => item.status,
        batchMap,
        rowMap,
        staleMinutes
      ),
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
      statuses: statusCounts,
      items: this.pickQueueItems(
        cutoutItems,
        item => ['running', 'failed', 'pending'].includes(item.cutoutStatus),
        item => item.cutoutStatus,
        batchMap,
        rowMap,
        staleMinutes
      ),
    };
  }

  private buildMockupQueue(
    items: PodGenerationItemEntity[],
    batchMap: Map<number, PodGenerationBatchEntity>,
    rowMap: Map<number, PodGenerationImportRowEntity>,
    staleMinutes: number
  ) {
    const mockupItems = items.filter(item => item.status === 'success');
    const waitingCutoutItems = mockupItems.filter(
      item => this.isWaitingCutoutForMockup(item)
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
      statuses: {
        ...statusCounts,
        completed: completedItems.length,
        skipped: skippedItems.length,
        waiting_cutout: waitingCutoutItems.length,
      },
      items: this.pickQueueItems(
        queueItems,
        item =>
          ['running', 'failed', 'pending'].includes(
            this.getMockupQueueStatus(item)
          ),
        item => this.getMockupQueueStatus(item),
        batchMap,
        rowMap,
        staleMinutes
      ),
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
    staleMinutes: number
  ) {
    const priority = {
      running: 1,
      failed: 2,
      pending: 3,
    } as Record<string, number>;
    return items
      .filter(predicate)
      .sort((a, b) => {
        const statusA = statusGetter(a) || '';
        const statusB = statusGetter(b) || '';
        return (
          (priority[statusA] || 99) - (priority[statusB] || 99) ||
          a.id - b.id
        );
      })
      .slice(0, 20)
      .map(item => {
        const batch = batchMap.get(item.batchId);
        const row = rowMap.get(item.batchId);
        const status = statusGetter(item) || 'pending';
        return {
          id: item.id,
          rowNo: row?.rowNo || null,
          batchId: item.batchId,
          batchNo: batch?.batchNo || row?.batchNo || '',
          itemNo: item.itemNo,
          topic: batch?.topic || row?.topic || '',
          status,
          stale:
            status === 'running' &&
            isStaleTime(item.updateTime, staleMinutes),
          updateTime: item.updateTime,
          error: item.error || item.cutoutError || item.mockupError || '',
        };
      });
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
}
