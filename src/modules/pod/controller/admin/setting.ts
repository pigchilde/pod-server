import { Body, Get, Inject, Post, Provide } from '@midwayjs/core';
import { BaseController, CoolController } from '@cool-midway/core';
import { PodSettingService } from '../../service/setting';

/**
 * POD模块设置
 *
 * 设置以单行 JSON 的方式保存在 pod_module_setting 表中，
 * 用于运行期覆盖图片模型、DeepSeek 模型、输出目录和统一提示词。
 */
@Provide()
@CoolController()
export class AdminPodSettingController extends BaseController {
  @Inject()
  podSettingService: PodSettingService;

  /**
   * 获得设置
   */
  @Get('/info', { summary: '获得设置' })
  async info() {
    return this.ok(await this.podSettingService.getPublicSettings());
  }

  /**
   * 保存设置
   */
  @Post('/save', { summary: '保存设置' })
  async save(@Body() body: any) {
    return this.ok(await this.podSettingService.saveSettings(body));
  }
}
