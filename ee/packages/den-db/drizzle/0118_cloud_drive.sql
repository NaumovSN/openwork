CREATE TABLE `cloud_drive_file` (
	`id` varchar(36) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`path` varchar(500) NOT NULL,
	`path_hash` varchar(64) NOT NULL,
	`storage_identity` varchar(64) NOT NULL,
	`object_key` varchar(700) NOT NULL,
	`size_bytes` bigint NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`status` enum('uploading','ready','deleting','deleted') NOT NULL DEFAULT 'uploading',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `cloud_drive_file_id` PRIMARY KEY(`id`),
	CONSTRAINT `cloud_drive_member_path` UNIQUE(`organization_id`,`member_id`,`path_hash`)
);
--> statement-breakpoint
CREATE INDEX `cloud_drive_member` ON `cloud_drive_file` (`organization_id`,`member_id`);