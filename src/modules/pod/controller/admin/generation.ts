import { Body, Get, Inject, Post, Provide, Query } from '@midwayjs/core';
import { BaseController, CoolController } from '@cool-midway/core';
import { PodGenerationBatchEntity } from '../../entity/batch';
import { PodGenerationService } from '../../service/generation';

/**
 * POD批量生成
 *
 * 管理后台入口：
 * - 批次 CRUD 走 CoolController 内置接口
 * - 提示词确认、生图、重试等业务动作走下面的自定义接口
 */
@Provide()
@CoolController({
  api: ['delete', 'info', 'list', 'page'],
  entity: PodGenerationBatchEntity,
  service: PodGenerationService,
  pageQueryOp: {
    fieldEq: ['a.status'],
    fieldLike: ['a.topic', 'a.topicSlug'],
    keyWordLikeFields: ['a.topic', 'a.topicSlug', 'a.batchNo'],
    addOrderBy: {
      'a.id': 'DESC',
    },
  },
})
export class AdminPodGenerationController extends BaseController {
  @Inject()
  podGenerationService: PodGenerationService;

  /**
   * 创建批次
   */
  @Post('/createBatch', { summary: '创建批次' })
  async createBatch(@Body() body: any) {
    return this.ok(await this.podGenerationService.createBatch(body));
  }

  /**
   * 执行批次中所有已确认且待生成的任务项
   */
  @Post('/runBatch', { summary: '执行批次' })
  async runBatch(@Body('id') id: number) {
    return this.ok(await this.podGenerationService.runBatch(id));
  }

  /**
   * 重试当前批次里的失败任务项
   */
  @Post('/retryFailed', { summary: '重试失败项' })
  async retryFailed(@Body('id') id: number) {
    return this.ok(await this.podGenerationService.retryFailed(id));
  }

  /**
   * 重新生成单个任务项
   */
  @Post('/retryItem', { summary: '重试任务项' })
  async retryItem(@Body('id') id: number) {
    return this.ok(await this.podGenerationService.retryItem(id));
  }

  /**
   * 批量重新生成选中的任务项
   */
  @Post('/retryItems', { summary: '批量重试任务项' })
  async retryItems(@Body() body: any) {
    return this.ok(await this.podGenerationService.retryItems(body));
  }

  /**
   * 对单个任务项执行抠图
   */
  @Post('/cutoutItem', { summary: '任务项抠图' })
  async cutoutItem(@Body('id') id: number) {
    return this.ok(await this.podGenerationService.cutoutItem(id));
  }

  /**
   * 对单个任务项生成 T 恤效果图
   */
  @Post('/generateMockupItem', { summary: '任务项生成效果图' })
  async generateMockupItem(@Body('id') id: number) {
    return this.ok(await this.podGenerationService.generateMockupItem(id));
  }

  /**
   * 更新提示词并重新置为待确认
   */
  @Post('/updatePrompt', { summary: '更新提示词' })
  async updatePrompt(@Body() body: any) {
    return this.ok(await this.podGenerationService.updatePrompt(body));
  }

  /**
   * 确认提示词
   */
  @Post('/approvePrompts', { summary: '确认提示词' })
  async approvePrompts(@Body() body: any) {
    return this.ok(await this.podGenerationService.approvePrompts(body));
  }

  /**
   * 驳回提示词
   */
  @Post('/rejectPrompts', { summary: '驳回提示词' })
  async rejectPrompts(@Body() body: any) {
    return this.ok(await this.podGenerationService.rejectPrompts(body));
  }

  /**
   * 批次详情
   */
  @Get('/detail', { summary: '批次详情' })
  async detail(@Query('id') id: number) {
    return this.ok(await this.podGenerationService.infoWithItems(id));
  }

  /**
   * 任务项分页
   */
  @Post('/items', { summary: '任务项分页' })
  async items(@Body() body: any) {
    return this.ok(await this.podGenerationService.items(body));
  }
}
