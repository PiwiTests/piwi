CREATE TABLE `assistant_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`title` text DEFAULT '' NOT NULL,
	`extra_tools` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_conversations_owner` ON `assistant_conversations` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_assistant_conversations_updated` ON `assistant_conversations` (`updated_at`);--> statement-breakpoint
CREATE TABLE `assistant_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`context` text,
	`tool_calls` text,
	`provider` text,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`status` text DEFAULT 'completed' NOT NULL,
	`error` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `assistant_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_messages_conversation` ON `assistant_messages` (`conversation_id`,`id`);--> statement-breakpoint
CREATE TABLE `assistant_nudge_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`nudge_id` text NOT NULL,
	`dismissed_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_nudge_dismissals_owner` ON `assistant_nudge_dismissals` (`owner_id`,`nudge_id`) WHERE owner_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_nudge_dismissals_shared` ON `assistant_nudge_dismissals` (`nudge_id`) WHERE owner_id IS NULL;--> statement-breakpoint
CREATE TABLE `assistant_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`provider` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_usage_created` ON `assistant_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_assistant_usage_owner` ON `assistant_usage` (`owner_id`,`created_at`);