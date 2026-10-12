SELECT 'CREATE DATABASE product_hub_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'product_hub_test')\gexec
