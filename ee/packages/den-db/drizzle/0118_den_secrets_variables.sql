CREATE TABLE `secret_binding_approval` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`member_id` varchar(64) NOT NULL,
	`connection_id` varchar(64) NOT NULL,
	`revision` int NOT NULL,
	`identity` varchar(64) NOT NULL,
	CONSTRAINT `secret_binding_approval_id` PRIMARY KEY(`id`),
	CONSTRAINT `secret_binding_approval_member_connection` UNIQUE(`organization_id`,`member_id`,`connection_id`)
);
--> statement-breakpoint
CREATE TABLE `secret_connection_binding` (
	`connection_id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`endpoint` varchar(2048) NOT NULL,
	`identity` varchar(64) NOT NULL,
	`revision` int NOT NULL DEFAULT 1,
	`headers` json NOT NULL,
	`definitions` json NOT NULL,
	CONSTRAINT `secret_connection_binding_connection_id` PRIMARY KEY(`connection_id`)
);
--> statement-breakpoint
CREATE TABLE `secret_definition` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`name` varchar(64) NOT NULL,
	`label` varchar(120) NOT NULL,
	`help_text` varchar(500) NOT NULL DEFAULT '',
	`kind` enum('secret','variable') NOT NULL,
	`source` enum('member','organization') NOT NULL,
	`required` boolean NOT NULL DEFAULT false,
	`revision` int NOT NULL DEFAULT 1,
	`retired` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `secret_definition_id` PRIMARY KEY(`id`),
	CONSTRAINT `secret_definition_org_name` UNIQUE(`organization_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `secret_value` (
	`id` varchar(64) NOT NULL,
	`organization_id` varchar(64) NOT NULL,
	`definition_id` varchar(64) NOT NULL,
	`owner_key` varchar(64) NOT NULL,
	`encrypted_value` text,
	`revision` int NOT NULL DEFAULT 1,
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `secret_value_id` PRIMARY KEY(`id`),
	CONSTRAINT `secret_value_definition_owner` UNIQUE(`organization_id`,`definition_id`,`owner_key`)
);
