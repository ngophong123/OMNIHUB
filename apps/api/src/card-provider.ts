import { BadRequestException } from '@nestjs/common';

export interface CardProviderAdapter {
  readonly name: string;
  readonly enabledForProduction: boolean;
  authorize(amountVnd: number): Promise<never>;
}

/** Explicit no-op adapter used until the store has an authorized acquiring provider. */
export class LabeledCardSandboxAdapter implements CardProviderAdapter {
  readonly name = 'SANDBOX_ONLY';
  readonly enabledForProduction = false;

  async authorize(_amountVnd: number): Promise<never> {
    throw new BadRequestException('CARD_PROVIDER_DISABLED_SANDBOX_NOT_CONFIGURED');
  }
}
