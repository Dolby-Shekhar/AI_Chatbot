#!/bin/bash

mkdir -p data
if [ ! -f data/db.json ]; then
  echo '{"users": {}, "summary": null}' > data/db.json
  echo "Database initialized"
fi

# Start the application
exec node server.js
