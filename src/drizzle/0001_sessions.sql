CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`source` text NOT NULL,
	`sensor_label` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at` ON `sessions` (`started_at`);--> statement-breakpoint
ALTER TABLE `events` ADD `session_id` integer REFERENCES sessions(id);--> statement-breakpoint
CREATE INDEX `idx_events_session` ON `events` (`session_id`);--> statement-breakpoint
ALTER TABLE `readings` ADD `session_id` integer REFERENCES sessions(id);--> statement-breakpoint
CREATE INDEX `idx_readings_session` ON `readings` (`session_id`);