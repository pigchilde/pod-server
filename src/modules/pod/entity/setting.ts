import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../base/entity/base';

/**
 * POD模块设置
 *
 * 当前只保存 default 一份设置，后续如果需要多租户或多渠道，可扩展 keyName。
 */
@Entity('pod_module_setting')
export class PodModuleSettingEntity extends BaseEntity {
  @Index({ unique: true })
  @Column({ comment: '设置键', default: 'default' })
  keyName: string;

  @Column({ comment: '设置数据', type: 'text' })
  data: string;
}
