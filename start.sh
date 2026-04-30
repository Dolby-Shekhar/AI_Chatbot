#!/bin/bash

# Initialize fresh database (clears old shared chats)
echo '{"sessions": {}, "activeSession": null, "summary": null}' > db.json
echo "Database initialized"

# Start the application
exec node server.js
