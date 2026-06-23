import { Init, Provide } from '@midwayjs/core';
import { BaseService, CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
import * as fs from 'fs';
import { PodGenerationImportEntity } from '../entity/import';
import { PodGenerationImportRowEntity } from '../entity/import-row';
import { PodGenerationBatchEntity } from '../entity/batch';
import { PodGenerationItemEntity } from '../entity/item';

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
