import { BaseController, CoolController } from '@cool-midway/core';
import { Files, Inject, Post, Provide } from '@midwayjs/core';
import { PodCutoutService } from '../../service/cutout';

/**
 * POD独立抠图工具
 */
@Provide()
@CoolController()
export class AdminPodCutoutController extends BaseController {
  @Inject()
  podCutoutService: PodCutoutService;

  /**
   * 上传多张图片并执行抠图
   */
  @Post('/upload', { summary: '上传图片抠图' })
  async upload(@Files() files) {
    return this.ok(await this.podCutoutService.upload(files));
  }
}
