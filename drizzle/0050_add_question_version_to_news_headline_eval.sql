ALTER TABLE `news_headline_eval` ADD `question_version` text;
--> statement-breakpoint
UPDATE news_headline_eval SET question_version = 'v0' WHERE question_version IS NULL;