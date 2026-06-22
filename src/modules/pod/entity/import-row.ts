import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, transformerJson } from '../../base/entity/base';

/**
 * POD表格导入行
 *
 * 保留 Excel 每一行的解析结果、创建出的批次和行级错误，方便局部排查/重试。
 */
@Entity('pod_generation_import_row')
export class PodGenerationImportRowEntity extends BaseEntity {
  @Index()
  @Column({ comment: '导入任务ID' })
  importId: number;

  @Column({ comment: 'Excel行号' })
  rowNo: number;

  @Column({ comment: '主题', nullable: true, type: 'text' })
  topic: string;

  @Column({ comment: '数量', default: 0 })
  count: number;

  @Index()
  @Column({ comment: '生图批次ID', nullable: true })
  batchId: number;

  @Column({ comment: '生图批次号', nullable: true, length: 80 })
  batchNo: string;

  @Index()
  @Column({
    comment:
      '状态 pending/creating_batch/prompt_generating/image_generating/post_processing/verifying/completed/created/failed',
    length: 30,
    default: 'pending',
  })
  status: string;

  @Column({
    comment: '原始行数据',
    nullable: true,
    type: 'json',
    transformer: transformerJson,
  })
  rawData: Record<string, any>;

  @Column({ comment: '错误信息', nullable: true, length: 1000 })
  error: string;
}
