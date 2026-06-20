import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, transformerJson } from '../../base/entity/base';

/**
 * POD表格导入任务
 *
 * 一次 Excel 上传对应一条导入任务，用于追踪每一行创建出的生图批次。
 */
@Entity('pod_generation_import')
export class PodGenerationImportEntity extends BaseEntity {
  @Index({ unique: true })
  @Column({ comment: '导入编号', length: 80 })
  importNo: string;

  @Column({ comment: '原始文件名', nullable: true, length: 220 })
  fileName: string;

  @Index()
  @Column({
    comment: '状态 processing/completed/partial_failed/failed',
    length: 30,
    default: 'processing',
  })
  status: string;

  @Column({ comment: '总行数', default: 0 })
  totalRows: number;

  @Column({ comment: '成功行数', default: 0 })
  successRows: number;

  @Column({ comment: '失败行数', default: 0 })
  failedRows: number;

  @Column({ comment: '计划生成图片数', default: 0 })
  totalImages: number;

  @Column({
    comment: '导入选项',
    nullable: true,
    type: 'json',
    transformer: transformerJson,
  })
  options: Record<string, any>;

  @Column({ comment: '错误信息', nullable: true, length: 1000 })
  error: string;
}
