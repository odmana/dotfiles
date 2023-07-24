alias nx="nix-shell --command zsh"
alias cls="clear"

# fshow - git commit browser (enter for show, ctrl-d for diff, ` toggles sort)
fshow() {
  git log --graph --color=always \
      --format="%C(auto)%h%d %s %C(black)%C(bold)%cr" "$@" |
  fzf --ansi --preview "echo {} | grep -o '[a-f0-9]\{7\}' | head -1 | xargs -I % sh -c 'git show % | diff-so-fancy'" \
             --bind "enter:execute:
                (grep -o '[a-f0-9]\{7\}' | head -1 |
                xargs -I % sh -c 'git show % | diff-so-fancy | less -R') << 'FZF-EOF'
                {}
FZF-EOF"
}

# Create a fixup commit from fzf search of your branch's commits
fixup() {
  local default out sha

  git diff --cached --quiet --exit-code
  if [ $? -ne 1 ]; then
    echo "No files are staged for a fixup"
    return
  fi

  default=`git default-branch`;
  out=$(
    git log ${default}.. --graph --color=always \
        --format="%C(auto)%h%d %s %C(black)%C(bold)%cr" "$@" |
    fzf --ansi --no-sort --reverse --query="$q" --tiebreak=index \
        --preview "echo 'Currently staged...\n' && git diff --cached --color" --toggle-sort=\`)

  sha=$(sed 's/^[^a-z0-9]*//;/^$/d' <<< "$out" | awk '{print $1}')
  if [ ! -z "$sha" ]; then
    git commit --fixup "$sha"
  fi
}

# fh - repeat history
fh() {
  print -z $( ([ -n "$ZSH_NAME" ] && fc -l 1 || history) | fzf +s --tac | sed -E 's/ *[0-9]*\*? *//' | sed -E 's/\\/\\\\/g')
}

# gitpublish - Push a branch to origin and set upstream tracking.
# Will abort if you're on the default branch. You should be publishing a feature branch.
# Warns you if there are uncommitted changes - but does not abort.
gitpublish() {
  local DEFAULT BRANCH

  DEFAULT=`git default-branch`;
  BRANCH=`git symbolic-ref --short -q HEAD`;
  if [ "$BRANCH" = "$DEFAULT" ]; then
      echo "You're on the default branch. You shouldn't publish this.";
      return 1;
  fi;
  if [[ -n $(git status -s) ]]; then
      echo "WARNING: You have uncommitted changes or a dirty working tree.";
      echo "WARNING: I'm not telling you what to do, but maybe you forgot to commit?"
  fi;
  echo "Publishing an upstream branch for $BRANCH.";
  git push -u origin $BRANCH;
}

# gitunwind - Unwind a branch
# Once a branch has been merged to the default branch, run this to make the local repository clean again.
# First checks that the current branch is not ahead of the default branch. Will abort if it isn't.
# Prunes remote branches (so, delete your upstream branches once they are merged and finalised.)
# Switches to the default branch, and deletes the local branch that you were on previously.
# Fast-forwards the default branch to origin/{default}.
gitunwind() {
  local DEFAULT BRANCH HEADREV BASEREV

  if [[ -n $(git status -s) ]]; then
      echo "You have uncommitted changes or a dirty working tree. Aborting.";
      git status -s;
      return 1;
  fi;

  DEFAULT=`git default-branch`;
  BRANCH=`git symbolic-ref --short -q HEAD`;
  if [ "$BRANCH" != "$DEFAULT" ]; then
      echo "Pulling remote changes...";
      git fetch --prune origin;
      HEADREV=`git rev-parse HEAD`;
      BASEREV=`git merge-base HEAD origin/$DEFAULT`;
      if [ "$HEADREV" = "$BASEREV" ]; then
          echo "Great; $BRANCH is on $DEFAULT. Unwinding...";
          git checkout $DEFAULT;
          git merge origin/$DEFAULT --ff-only;
          git branch -d $BRANCH;
          echo ""
          echo "Unwind complete. Deleted: $BRANCH."
          echo "Here's what you missed:"
          echo ""
          git log --oneline $HEADREV~1..$DEFAULT
      else
          echo "$BRANCH is ahead of $DEFAULT. Aborting."
      fi;
  else
      echo "You're on $DEFAULT. Nothing to unwind!";
      echo "Will update instead.";
      git pull --prune;
  fi;
}

# nvmup - Register nvm scripts and autocompletes.
# These scripts are slow to run at startup. Hence they were moved to a function that can be run on demand.
nvmup() {
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # This loads nvm
  [ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
}

# openpr - Run git push and then immediately open the Pull Request URL
# Open the Pull Request URL for your current directory's branch
openpr() {
  gitpublish;

  if [ $? -eq 0 ]; then
    default=`git default-branch`;
    github_url=`git remote -v | awk '/fetch/{print $2}' | sed -Ee 's#(git@|git://)#https://#' -e 's@com:@com/@' -e 's%\.git$%%' | awk '/github/'`;
    branch_name=`git symbolic-ref HEAD | cut -d"/" -f 3,4`;
    pr_url=$github_url"/compare/$default..."$branch_name

    if command -v open &> /dev/null
    then
      open $pr_url;
    elif command -v xdg-open &> /dev/null
    then
      xdg-open $pr_url;
    else 
      start "" "$pr_url";
    fi
  else
    echo 'failed to push commits and open a pull request.';
  fi
}
