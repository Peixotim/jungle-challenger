import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { ApplicationModule } from './modules/application.module.js';
import { HttpModule } from './modules/http.module.js';
import { MessagingModule } from './modules/messaging.module.js';
import { ObservabilityModule } from './modules/observability.module.js';
import { PersistenceModule } from './modules/persistence.module.js';

@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    PersistenceModule,
    ApplicationModule,
    MessagingModule,
    HttpModule,
  ],
})
export class AppModule {}
