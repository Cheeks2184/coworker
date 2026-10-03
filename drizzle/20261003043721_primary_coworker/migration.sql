CREATE TABLE `peer_tasks` (
	`task_id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`from_coworker_id` text,
	`to_coworker_id` text NOT NULL,
	`origin_thread_id` text NOT NULL,
	`reply_to_coworker_id` text,
	`origin_task_id` text,
	`depth` integer NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	CONSTRAINT `fk_peer_tasks_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_peer_tasks_from_coworker_id_coworkers_id_fk` FOREIGN KEY (`from_coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_peer_tasks_to_coworker_id_coworkers_id_fk` FOREIGN KEY (`to_coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_peer_tasks_origin_thread_id_conversations_id_fk` FOREIGN KEY (`origin_thread_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_peer_tasks_reply_to_coworker_id_coworkers_id_fk` FOREIGN KEY (`reply_to_coworker_id`) REFERENCES `coworkers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_peer_tasks_origin_task_id_tasks_id_fk` FOREIGN KEY (`origin_task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT "peer_tasks_kind_check" CHECK("kind" in ('request', 'reply')),
	CONSTRAINT "peer_tasks_depth_check" CHECK("depth" >= 0)
);
--> statement-breakpoint
ALTER TABLE `coworkers` ADD `is_primary` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `coworkers` ADD `tags_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `coworkers` ADD `avatar_image` text;--> statement-breakpoint
CREATE INDEX `peer_tasks_pair_idx` ON `peer_tasks` (`from_coworker_id`,`to_coworker_id`,`created_at`);