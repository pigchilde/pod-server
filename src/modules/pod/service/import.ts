import { Init, Provide } from '@midwayjs/core';
import { BaseService, CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, Repository } from 'typeorm';
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

    const [batches, progressRows] = await Promise.all([
      this.batchEntity.find({
        where: { id: In(batchIds) },
      }),
      this.itemEntity
        .createQueryBuilder('item')
        .select('item.batchId', 'batchId')
        .addSelect(
          "SUM(CASE WHEN item.status = 'success' THEN 1 ELSE 0 END)",
          'successCount'
        )
        .addSelect(
          "SUM(CASE WHEN item.status = 'failed' THEN 1 ELSE 0 END)",
          'failedCount'
        )
        .addSelect(
          "SUM(CASE WHEN item.cutoutStatus = 'failed' THEN 1 ELSE 0 END)",
          'cutoutFailedCount'
        )
        .addSelect(
          "SUM(CASE WHEN item.mockupStatus = 'failed' THEN 1 ELSE 0 END)",
          'mockupFailedCount'
        )
        .addSelect(
          "SUM(CASE WHEN item.verifyStatus = 'failed' THEN 1 ELSE 0 END)",
          'verifyFailedCount'
        )
        .where('item.batchId IN (:...batchIds)', { batchIds })
        .groupBy('item.batchId')
        .getRawMany(),
    ]);
    const batchMap = new Map(batches.map(batch => [batch.id, batch]));
    const progressMap = new Map(
      progressRows.map(row => [
        Number(row.batchId),
        {
          successCount: Number(row.successCount || 0),
          failedCount: Number(row.failedCount || 0),
          cutoutFailedCount: Number(row.cutoutFailedCount || 0),
          mockupFailedCount: Number(row.mockupFailedCount || 0),
          verifyFailedCount: Number(row.verifyFailedCount || 0),
        },
      ])
    );

    return rows.map(row => {
      const batch = batchMap.get(row.batchId);
      const progress = progressMap.get(row.batchId);
      return {
        ...row,
        batchStatus: batch?.status || '',
        batchCount: batch?.count || row.count || 0,
        batchSuccessCount: progress?.successCount || 0,
        batchFailedCount: progress?.failedCount || 0,
        cutoutFailedCount: progress?.cutoutFailedCount || 0,
        mockupFailedCount: progress?.mockupFailedCount || 0,
        verifyFailedCount: progress?.verifyFailedCount || 0,
      };
    });
  }
}
