# Install Homebrew /usr/bin/ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"

brew install diff-so-fancy

brew cask install alacritty

brew install bat

brew install fzf

brew install tmux
curl -L https://git.io/tmux-up -o /usr/local/bin/tmux-up

brew install zsh zsh-completions
brew install zsh-syntax-highlighting

# Install "Oh my ZSH"
sh -c "$(curl -fsSL https://raw.github.com/robbyrussell/oh-my-zsh/master/tools/install.sh)"
sudo chsh -s /bin/zsh

# Install "Powerlevel9k Zsh Theme"
git clone https://github.com/romkatv/powerlevel10k.git  ~/.oh-my-zsh/custom/themes/powerlevel10k

# Install "Zsh Autosuggestions"
git clone https://github.com/zsh-users/zsh-autosuggestions ~/.oh-my-zsh/custom/plugins/zsh-autosuggestions

# Install "Tmux Plugin Manager"
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm

./create-links.sh
