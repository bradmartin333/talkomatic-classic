# Talkomatic

**The world's first chat room, reborn.** Real-time, character-by-character chat where everyone sees you type as you type, just like the original 1973 PLATO system.

## Contributing

This is a personal fork trimmed for one private deployment, not a project taking outside contributions. For the full-featured version, see [upstream](https://github.com/mohdmahmodi/talkomatic-classic).

## Accounts

Everything sits behind a login page. There is no sign-up: the operator hands
out accounts from inside the container (the commands only answer loopback, so
container shell access is the credential).

```
docker compose exec talkomatic npm run ops -- adduser mom <password>
docker compose exec talkomatic npm run ops -- users
docker compose exec talkomatic npm run ops -- passwd mom <password>   # also signs them out
docker compose exec talkomatic npm run ops -- deluser mom             # also signs them out
```

Signing in lasts a year per browser; `/logout` ends it early. Accounts live in
`accounts.json` in `DATA_DIR`. The name people show in the chat is still their
own pick, separate from the login name.

## License

[MIT](license)

## Credits

Built and maintained by [Mohd Mahmodi](https://mohdmahmodi.com) ([@mohdmahmodi](https://x.com/mohdmahmodi)) with the Talkomatic community. Inspired by the original Talkomatic by Doug Brown and David R. Woolley (PLATO, 1973).
