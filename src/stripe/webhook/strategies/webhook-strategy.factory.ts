import { Injectable, Inject } from "@nestjs/common";
import { WebhookStrategy } from "./webhook-strategy.interface";

@Injectable()
export class WebhookStrategyFactory {
  constructor(
    @Inject("WEBHOOK_STRATEGIES") private readonly strategies: WebhookStrategy[]
  ) {}

  getStrategy(eventType: string): WebhookStrategy | undefined {
    return this.strategies.find(strategy => strategy.canHandle(eventType));
  }
}
