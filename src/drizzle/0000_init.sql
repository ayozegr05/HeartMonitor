CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`timestamp` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_timestamp` ON `events` (`timestamp`);--> statement-breakpoint
CREATE TABLE `readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`bpm` integer NOT NULL,
	`rr_intervals_ms` text,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_readings_timestamp` ON `readings` (`timestamp`);