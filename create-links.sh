
#!/bin/bash

echo ""
echo "Setting up gitconfig links"
gitconfig=~/.gitconfig
rm "$gitconfig"
ln -s ~/dotfiles/git/gitconfig "$gitconfig"
ls -al "$gitconfig"

echo ""
echo "Setting up gitignore links"
gitignore=~/.gitignore
rm "$gitignore"
ln -s ~/dotfiles/git/gitignore "$gitignore"
ls -al "$gitignore"

echo ""
echo "Setting up zsh links"
zsh=~/.zshrc
rm "$zsh"
ln -s ~/dotfiles/zsh/zshrc "$zsh"
ls -al "$zsh"
