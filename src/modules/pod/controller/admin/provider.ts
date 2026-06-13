import { Get, Inject, Provide, Query } from '@midwayjs/core';
import { BaseController, CoolController } from '@cool-midway/core';
import { PodProviderConfigEntity } from '../../entity/provider';
import { PodProviderConfigService } from '../../service/provider';

/**
 * POD供应商配置
 */
@Provide()
@CoolController({
  api: ['add', 'delete', 'update', 'info', 'list', 'page'],
  entity: PodProviderConfigEntity,
  service: PodProviderConfigService,
  pageQueryOp: {
    fieldEq: ['a.type', 'a.enabled'],
    keyWordLikeFields: ['a.name', 'a.code', 'a.endpoint', 'a.model'],
    addOrderBy: {
      'a.orderNum': 'ASC',
      'a.id': 'DESC',
    },
  },
})
export class AdminPodProviderController extends BaseController {
  @Inject()
  podProviderConfigService: PodProviderConfigService;

  /**
   * 供应商下拉选项
   */
  @Get('/options', { summary: '供应商下拉选项' })
  async options(@Query('type') type: 'image' | 'prompt') {
    return this.ok(await this.podProviderConfigService.options(type));
  }
}
