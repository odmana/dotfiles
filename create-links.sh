
#!/bin/bash

echo ""
echo "Setting up gitconfig links"
gitconfig=~/.gitconfig
[ -e "$gitconfig" ] && rm "$gitconfig"
ln -s ~/dotfiles/git/gitconfig "$gitconfig"
ls -al "$gitconfig"

echo ""
echo "Setting up gitignore links"
gitignore=~/.gitignore
[ -e "$gitignore" ] && rm "$gitignore"
ln -s ~/dotfiles/git/gitignore "$gitignore"
ls -al "$gitignore"

echo ""
echo "Setting up starship links"
mkdir -p ~/.config/
starship=~/.config/starship.toml
[ -e "$starship" ] && rm "$starship"
ln -s ~/dotfiles/starship/starship.toml "$starship"
ls -al "$starship"

echo ""
echo "Setting up zsh links"
zsh=~/.zshrc
[ -e "$zsh" ] && rm "$zsh"
ln -s ~/dotfiles/zsh/zshrc "$zsh"
ls -al "$zsh"

echo ""
echo "Setting up vim links"
vim=~/.vimrc
[ -e "$vim" ] && rm "$vim"
ln -s ~/dotfiles/vim/vimrc "$vim"
ls -al "$vim"

echo ""
echo "Setting up alacritty links"
mkdir -p ~/.config/alacritty/
alacritty=~/.config/alacritty/alacritty.toml
[ -e "$alacritty" ] && rm "$alacritty"
ln -s ~/dotfiles/alacritty/alacritty.toml "$alacritty"
ls -al "$alacritty"

echo ""
echo "Setting up herdr links"
mkdir -p ~/.config/herdr/
herdr=~/.config/herdr/config.toml
[ -e "$herdr" ] && rm "$herdr"
ln -s ~/dotfiles/herdr/config.toml "$herdr"
ls -al "$herdr"

echo ""
echo "Setting up herdr app config"
# Copied, not linked: the app only hot-reloads files under ~/.config/herdr-app.
# Run `herdr-app-sync` to copy changes made in the app back into dotfiles.
~/dotfiles/bin/herdr-app-sync --install
