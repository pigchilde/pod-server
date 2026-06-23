import { CommonSchedule, Inject, Provide, TaskLocal } from '@midwayjs/core';
import { ILogger } from '@midwayjs/logger';
import { PodGenerationService } from '../service/generation';

/**
 * POD 后处理队列
 *
 * 生图成功后，抠图和效果图由这里独立推进，避免 ComfyUI 或 mockup 慢任务阻塞主生图队列。
 */
@Provide()
export class PodPostProcessSchedule implements CommonSchedule {
  @Inject()
  podGenerationService: PodGenerationService;

  @Inject()
  logger: ILogger;

  // 轻量轮询即可；抠图内部固定串行，效果图内部小并发。
  @TaskLocal('*/20 * * * * *')
  async exec() {
    const staleCount =
      await this.podGenerationService.recoverStaleProcessingItems();
    const cutoutCount = await this.podGenerationService.processQueuedCutouts({
      limit: 10,
      recoverStale: false,
    });
    const mockupCount = await this.podGenerationService.processQueuedMockups({
      limit: 20,
      concurrency: 2,
      recoverStale: false,
    });

    if (staleCount || cutoutCount || mockupCount) {
      this.logger.info(
        `[POD_POST_PROCESS] stale=${staleCount} cutout=${cutoutCount} mockup=${mockupCount}`
      );
    }
  }
}
