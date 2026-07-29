# Talkomatic

<img src="public/images/icons/favicon.png" alt="Talkomatic Logo" width="100px">

Talkomatic is an online platform for real-time text communication, essentially a modern reimagining of the classic chat room experience. Users can type messages, and everyone in the room can see the messages as they are being typed, creating a unique and engaging chat experience.

**Check out the website here:** [classic.talkomatic.co](https://classic.talkomatic.co)

## Features

- **Real-time Chat**: See messages as they're being typed, not just after they're sent.
- **Multiple Room Types**: Create public, semi-private (with access code), or private rooms.
- **Flexible Layout**: Choose between horizontal or vertical room layouts.
- **User Presence**: See who's in the room and their locations.
- **Invite System**: Easily invite others to your chat room with a generated link.
- **Sound Notifications**: Audible cues when users join or leave the room.
- **Mobile Responsive**: Adapts to different screen sizes for a seamless experience on any device.

## Technologies Used

- Node.js
- Express.js
- Socket.IO
- HTML5
- CSS3
- JavaScript (ES6+)

## Prerequisites

Before you begin, ensure you have met the following requirements:

- You have installed Node.js (version 12.0 or later)
- You have a basic understanding of JavaScript and Node.js

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/MohdYahyaMahmodi/talkomatic-classic.git
   ```

2. Navigate to the project directory:
   ```
   cd talkomatic-classic
   ```

3. Install the dependencies:
   ```
   npm install
   ```

## Configuration

The application works without configuration, but you can customize it using an optional `.env` file. Copy `.env.example` to `.env` and fill in what you need:

| Variable          | Default              | Purpose                                                                                    |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `SESSION_SECRET`  | random per boot      | Set this in production so sessions and room access codes survive restarts                  |
| `PORT`            | `3000`               | Port the server listens on                                                                 |
| `HOST`            | `0.0.0.0`            | Bind address                                                                               |
| `ALLOWED_ORIGINS` | (none)               | Comma-separated public URLs of your instance, required when deploying on your own domain   |
| `DATA_DIR`        | repo root            | Where runtime JSON state (rooms, bans, identity, logs) is written                          |
| `TRUST_PROXY`     | `1`                  | Reverse-proxy hops to trust; set `0` if the server is exposed directly                     |
| `DEV_KEY_HASH`    | (none)               | SHA-256 hash of the owner dev key                                                          |

## Running the Application

To run Talkomatic:

```bash
npm start
```
The application will be available at `http://localhost:3000` (or the port specified in your `.env` file if you created one).

## Deploying with Docker / Dokploy

The repo ships with a `Dockerfile` and `docker-compose.yml`. The container listens on port `3000`, binds `0.0.0.0`, and keeps all runtime state in a volume at `/app/data`.

**Docker Compose:**

```bash
docker compose up -d --build
```

**Dokploy:**

1. Create an **Application** in Dokploy pointing at this Git repository.
2. Set the build type to **Dockerfile** (or use Docker Compose with the included `docker-compose.yml`).
3. Set environment variables:
   - `SESSION_SECRET` — a long random string (`openssl rand -hex 32`)
   - `ALLOWED_ORIGINS` — the URL you will serve the app at, e.g. `https://chat.example.com` (use `http://SERVER_IP:3000` if you have no domain yet)
4. If deploying via Dockerfile, add a volume mount for `/app/data` so rooms, bans, and identity data survive redeploys.
5. Point your domain at the app with container port `3000`. Dokploy's Traefik proxy handles HTTPS; the server already trusts one proxy hop.

## Usage

1. **Joining the Lobby**:
   - Open your web browser and navigate to `http://localhost:3000`.
   - Enter your name and optional location to sign in.

2. **Creating a Room**:
   - In the lobby, fill in the room details (name, type, layout).
   - Click "Go Chat" to create and enter the room.

3. **Joining a Room**:
   - In the lobby, you'll see a list of available public and semi-private rooms.
   - Click "Enter" on any room to join.
   - For semi-private rooms, you'll need to enter the access code.

4. **Chatting**:
   - Once in a room, start typing in your designated text area.
   - Your message will appear in real-time for all users in the room.

5. **Inviting Others**:
   - Use the invite link provided in the room to invite others.

6. **Leaving a Room**:
   - Click "Leave Room" to exit and return to the lobby.

## Contributing

We welcome contributions to Talkomatic! Here are some ways you can contribute:

1. Report bugs and suggest features by opening issues.
2. Submit pull requests with bug fixes or new features.
3. Improve documentation or add translations.

Please read our [Contributing Guidelines](CONTRIBUTING.md) for more details.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by the original [Talkomatic](https://en.wikipedia.org/wiki/Talkomatic) chat system from the 1970s.
- Thanks to all contributors who have helped shape this project.

## Author

**Mohd Mahmodi**

- Website: [mohdmahmodi.com](https://mohdmahmodi.com)
- Twitter: [@mohdmahmodi](https://twitter.com/mohdmahmodi)
- Email: contact@mohdmahmodi.com

## Contact

If you have any questions or feedback, please feel free to reach out:

- Open an issue on GitHub
- Contact the author directly using the information above

---

Enjoy chatting with Talkomatic!
