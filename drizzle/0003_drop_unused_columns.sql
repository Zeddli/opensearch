ALTER TABLE "seller_profiles" DROP COLUMN "persona";--> statement-breakpoint
ALTER TABLE "seller_profiles" DROP COLUMN "is_seeded";--> statement-breakpoint
UPDATE "buyer_profiles" SET "paypal_vault_id" = NULL WHERE "paypal_vault_id" ILIKE 'DEMO-%';--> statement-breakpoint
UPDATE "seller_profiles" SET "paypal_merchant_id" = NULL, "onboarding_status" = 'none', "platform_fee_enabled" = false WHERE "paypal_merchant_id" ILIKE 'DEMO-%';
