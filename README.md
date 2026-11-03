## Windows Instructions

Follow these instructions

https://kittywhiskers.eu/zsh-and-unix-style-native-system-on-windows/

but use the following instructions for the `Configuring MSYS2` section

https://github.com/git-for-windows/git/wiki/Install-inside-MSYS2-proper

Cut down default set of unix apps

```
pacman -S man vim wget curl \
		rsync openssh \
		zip unzip gzip \
		pactoys \
		mingw64/mingw-w64-x86_64-jq \
		zsh
```

Install apps:

```
winget install gerardog.gsudo
winget install alacritty
winget install Schniz.fnm
```

Fix git after following SSH steps:

https://stackoverflow.com/questions/370030/why-git-cant-remember-my-passphrase-under-windows/58784438#58784438
