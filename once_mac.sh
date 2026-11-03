## Install Homebrew before running ##
# /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install tools
brew install diff-so-fancy
brew install bat
brew install fzf
brew install herdr

# Install terminal
brew install --cask alacritty
brew install --cask herdr-app
brew install --cask font-jetbrains-mono-nerd-font

# Install zsh if missing, and make it the default shell if it isn't already
command -v zsh >/dev/null || brew install zsh
case "$(dscl . -read "/Users/$USER" UserShell | awk '{print $2}')" in
  */zsh) ;;
  *) chsh -s /bin/zsh ;;  # macOS's own zsh: always present and listed in /etc/shells
esac
brew install starship zoxide zsh-autosuggestions zsh-syntax-highlighting zsh-completions

# Symlink dotfiles
./create-links.sh
