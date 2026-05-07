-- Minimal schema mirroring the columns the Lambdas read/write.
-- Note: matches the original Lambda's typo "original_resoultion".
CREATE TABLE IF NOT EXISTS "VideoFile" (
    id SERIAL PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,
    original_resoultion TEXT,
    status TEXT,
    "jobId" TEXT,
    url TEXT
);
