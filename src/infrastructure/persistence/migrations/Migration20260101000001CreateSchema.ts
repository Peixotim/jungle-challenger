import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000001CreateSchema extends Migration {
  up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_player_currency_unique unique (player_id, currency)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id text not null,
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        status text not null,
        reference_transaction_id uuid references wager_transactions (id),
        failure_code text,
        processed_at timestamptz,
        observed_balance numeric(20, 2),
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique
          unique (provider_id, external_transaction_id),
        constraint wager_transactions_kind_valid
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_amount_positive check (amount > 0),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_observed_balance_non_negative
          check (observed_balance is null or observed_balance >= 0),
        constraint wager_transactions_reversal_needs_reference
          check ((kind in ('REFUND', 'ROLLBACK')) = (reference_external_transaction_id is not null)
                 or kind in ('WIN', 'LOSS')),
        constraint wager_transactions_processed_at_matches_status
          check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_transactions_failure_code_matches_status
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_resolved_reference_only_when_processed
          check (reference_transaction_id is null or status = 'PROCESSED'),
        constraint wager_transactions_retry_only_when_pending_reference
          check (next_reference_attempt_at is null or status = 'PENDING_REFERENCE'),
        constraint wager_transactions_attempts_non_negative check (reference_attempts >= 0)
      )
    `);

    this.addSql(`
      create unique index wager_transactions_reversal_unique
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED'
          and kind in ('REFUND', 'ROLLBACK')
          and reference_transaction_id is not null
    `);

    this.addSql(`
      create index wager_transactions_pending_reference_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        seq bigint generated always as identity,
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_balances_non_negative
          check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_balanced
          check ((direction = 'CREDIT' and balance_after = balance_before + amount)
              or (direction = 'DEBIT' and balance_after = balance_before - amount)),
        constraint wallet_ledger_entries_one_per_wallet_transaction
          unique (wallet_id, transaction_id)
      )
    `);

    this.addSql(
      'create unique index wallet_ledger_entries_wallet_seq on wallet_ledger_entries (wallet_id, seq)',
    );

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        constraint outbox_messages_attempts_non_negative check (attempts >= 0)
      )
    `);

    this.addSql(`
      create index outbox_messages_unpublished
        on outbox_messages (occurred_at)
        where published_at is null
    `);
  }

  down(): void {
    this.addSql('drop table if exists outbox_messages');
    this.addSql('drop table if exists inbox_messages');
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
  }
}
