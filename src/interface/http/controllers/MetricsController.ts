import { Controller, Get, Header, Inject } from '@nestjs/common';
import { PrometheusMetrics } from '../../../infrastructure/observability/PrometheusMetrics.js';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): string {
    return this.metrics.render();
  }
}
