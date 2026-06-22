import { Body, Get, Inject, Post, Provide, Query } from '@midwayjs/core';
import {
  BaseController,
  CoolCommException,
  CoolController,
} from '@cool-midway/core';
import { PodGenerationImportEntity } from '../../entity/import';
import { PodGenerationImportService } from '../../service/import';
import { PodGenerationService } from '../../service/generation';

/**
 * POD表格导入记录
 */
@Provide()
@CoolController({
  api: ['info', 'list', 'page', 'delete'],
  entity: PodGenerationImportEntity,
  service: PodGenerationImportService,
  pageQueryOp: {
    fieldEq: ['a.status'],
    keyWordLikeFields: ['a.importNo', 'a.fileName', 'a.error'],
    addOrderBy: {
      'a.id': 'DESC',
    },
  },
})
export class AdminPodGenerationImportController extends BaseController {
  @Inject()
  podGenerationImportService: PodGenerationImportService;

  @Inject()
  podGenerationService: PodGenerationService;

  @Get('/detail', { summary: '导入详情' })
  async detail(@Query('id') id: number) {
    return this.ok(await this.podGenerationImportService.detail(id));
  }

  @Post('/rows', { summary: '导入行分页' })
  async rows(@Body() body: any) {
    return this.ok(await this.podGenerationImportService.rows(body));
  }

  @Post('/retryRow', { summary: '重试导入行' })
  async retryRow(@Body('id') id: number) {
    return this.ok(
      await this.podGenerationService.retryImportRow(this.parseId(id))
    );
  }

  @Post('/repairRow', { summary: '修复导入行关联批次' })
  async repairRow(@Body('id') id: number) {
    return this.ok(
      await this.podGenerationService.repairImportRow(this.parseId(id))
    );
  }

  @Post('/repairImport', { summary: '修复导入记录失败项' })
  async repairImport(@Body('id') id: number) {
    return this.ok(
      await this.podGenerationService.repairImport(this.parseId(id))
    );
  }

  @Post('/runImport', { summary: '继续执行导入记录' })
  async runImport(@Body('id') id: number) {
    return this.ok(await this.podGenerationService.runImport(this.parseId(id)));
  }

  private parseId(id: number) {
    const value = Number(id);
    if (!value || !Number.isFinite(value)) {
      throw new CoolCommException('缺少参数 id');
    }
    return value;
  }
}
