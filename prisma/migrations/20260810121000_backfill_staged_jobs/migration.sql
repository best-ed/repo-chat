-- Before STAGED existed, a staged job rested at CLONING with progress === total.
-- Translate those rows onto the real status; left alone they are
-- indistinguishable from a genuinely in-flight clone and would never restart.
--
-- Separate from the ALTER TYPE migration on purpose: Postgres will not let a
-- newly added enum value be used in the same transaction that added it.
UPDATE "Job"
SET status = 'STAGED'
WHERE status = 'CLONING'
  AND total > 0
  AND progress = total;
