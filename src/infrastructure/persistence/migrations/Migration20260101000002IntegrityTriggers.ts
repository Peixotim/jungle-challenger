import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000002IntegrityTriggers extends Migration {
  up(): void {
    this.addSql(`
      create function forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception '% on % is not allowed: the table is append-only', tg_op, tg_table_name
          using errcode = 'integrity_constraint_violation';
      end
      $$
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_mutation()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_mutation()
    `);
    this.addSql(`
      create trigger wager_transactions_no_delete
        before delete on wager_transactions
        for each row execute function forbid_mutation()
    `);

    this.addSql(`
      create function guard_wager_transaction_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%) and cannot change', old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
            new.kind, new.amount, new.currency, new.reference_external_transaction_id,
            new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
            old.kind, old.amount, old.currency, old.reference_external_transaction_id,
            old.created_at) then
          raise exception 'immutable columns of wager transaction % cannot change', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger wager_transactions_guard_update
        before update on wager_transactions
        for each row execute function guard_wager_transaction_update()
    `);

    this.addSql(`
      create function check_ledger_chain() returns trigger language plpgsql as $$
      declare
        previous_balance numeric(20, 2);
        wallet_currency char(3);
      begin
        select currency into wallet_currency from wallets where id = new.wallet_id;
        if wallet_currency is distinct from new.currency then
          raise exception 'ledger entry currency % differs from wallet currency %',
            new.currency, wallet_currency
            using errcode = 'integrity_constraint_violation';
        end if;

        select balance_after into previous_balance
          from wallet_ledger_entries
          where wallet_id = new.wallet_id
          order by seq desc
          limit 1;

        if coalesce(previous_balance, 0) <> new.balance_before then
          raise exception 'ledger chain broken for wallet %: expected balance_before %, got %',
            new.wallet_id, coalesce(previous_balance, 0), new.balance_before
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_chain
        before insert on wallet_ledger_entries
        for each row execute function check_ledger_chain()
    `);

    this.addSql(`
      create function assert_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target_wallet uuid;
        stored_balance numeric(20, 2);
        last_ledger_balance numeric(20, 2);
      begin
        if tg_table_name = 'wallets' then
          target_wallet := new.id;
        else
          target_wallet := new.wallet_id;
        end if;
        select balance into stored_balance from wallets where id = target_wallet;
        select balance_after into last_ledger_balance
          from wallet_ledger_entries
          where wallet_id = target_wallet
          order by seq desc
          limit 1;

        if stored_balance is distinct from coalesce(last_ledger_balance, 0) then
          raise exception 'wallet % balance % does not match its ledger (%)',
            target_wallet, stored_balance, coalesce(last_ledger_balance, 0)
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger wallets_match_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function assert_wallet_matches_ledger()
    `);
    this.addSql(`
      create constraint trigger ledger_entries_match_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function assert_wallet_matches_ledger()
    `);
  }

  down(): void {
    this.addSql(
      'drop trigger if exists ledger_entries_match_wallet on wallet_ledger_entries',
    );
    this.addSql('drop trigger if exists wallets_match_ledger on wallets');
    this.addSql('drop function if exists assert_wallet_matches_ledger()');
    this.addSql(
      'drop trigger if exists wallet_ledger_entries_chain on wallet_ledger_entries',
    );
    this.addSql('drop function if exists check_ledger_chain()');
    this.addSql(
      'drop trigger if exists wager_transactions_guard_update on wager_transactions',
    );
    this.addSql('drop function if exists guard_wager_transaction_update()');
    this.addSql(
      'drop trigger if exists wager_transactions_no_delete on wager_transactions',
    );
    this.addSql(
      'drop trigger if exists wallet_ledger_entries_no_truncate on wallet_ledger_entries',
    );
    this.addSql(
      'drop trigger if exists wallet_ledger_entries_immutable on wallet_ledger_entries',
    );
    this.addSql('drop function if exists forbid_mutation()');
  }
}
