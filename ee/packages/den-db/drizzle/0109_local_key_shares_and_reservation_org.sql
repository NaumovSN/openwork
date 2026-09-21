CREATE TABLE `gateway_local_key_shares` (
	`id` varchar(36) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`org_membership_id` varchar(64) NOT NULL,
	`request_id` varchar(36) NOT NULL,
	`request_hash` varchar(64) NOT NULL,
	`provider_id` varchar(255) NOT NULL,
	`gateway_provider_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `gateway_local_key_shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `gateway_local_key_share_request` UNIQUE(`organization_id`,`org_membership_id`,`request_id`)
);
--> statement-breakpoint
ALTER TABLE `inference_free_reservations` ADD `organization_id` varchar(64);--> statement-breakpoint
CREATE INDEX `gateway_local_key_share_provider` ON `gateway_local_key_shares` (`gateway_provider_id`);--> statement-breakpoint
CREATE INDEX `inference_free_reservation_org_created` ON `inference_free_reservations` (`organization_id`,`created_at`);