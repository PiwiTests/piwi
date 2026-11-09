-- Custom SQL migration file, put your code below! --

-- A cluster stored before this column was already heard of: its `cluster.new` reads as decided, and no run announces it.
UPDATE `failure_clusters` SET `announced_at` = `created_at` WHERE `announced_at` IS NULL;
