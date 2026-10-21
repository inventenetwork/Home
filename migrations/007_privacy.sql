-- Step 10: PDPA. Remember which version of the Terms and Privacy Notice a person agreed to when they signed up.
ALTER TABLE users ADD COLUMN consent_version text;
