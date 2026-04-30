#!/bin/bash

# Initialize database if it doesn't exist
if [ ! -f "db.json" ]; then
    echo '{"sessions": {}, "activeSession": "default", "summary": null}' > db.json
    echo "Database initialized"
fi

# Start the application
exec node server.js
