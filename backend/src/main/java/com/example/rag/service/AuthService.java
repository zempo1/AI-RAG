package com.example.rag.service;

import com.example.rag.config.JwtUtils;
import com.example.rag.entity.User;
import com.example.rag.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.mindrot.jbcrypt.BCrypt;
import org.springframework.stereotype.Service;

import java.util.Optional;

@Service
@RequiredArgsConstructor
public class AuthService {

    private final UserRepository userRepository;
    private final JwtUtils jwtUtils;

    public String register(String username, String password) {
        if (userRepository.findByUsername(username).isPresent()) {
            throw new RuntimeException("Username already exists");
        }
        User user = new User();
        user.setUsername(username);
        user.setPassword(BCrypt.hashpw(password, BCrypt.gensalt()));
        user = userRepository.save(user);
        return jwtUtils.generateToken(user.getId(), user.getUsername());
    }

    public String login(String username, String password) {
        User user = userRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("User not found"));
        
        if (!BCrypt.checkpw(password, user.getPassword())) {
            throw new RuntimeException("Invalid password");
        }
        
        return jwtUtils.generateToken(user.getId(), user.getUsername());
    }

    public void changePassword(Long userId, String oldPassword, String newPassword) {
        User user = userRepository.findById(userId)
                .orElseThrow(() -> new RuntimeException("User not found"));
        
        if (!BCrypt.checkpw(oldPassword, user.getPassword())) {
            throw new RuntimeException("原密码错误");
        }
        
        if (newPassword == null || newPassword.length() < 6) {
            throw new RuntimeException("新密码长度不能少于6位");
        }
        
        user.setPassword(BCrypt.hashpw(newPassword, BCrypt.gensalt()));
        userRepository.save(user);
    }

    public void changeUsername(Long userId, String newUsername) {
        User user = userRepository.findById(userId)
                .orElseThrow(() -> new RuntimeException("User not found"));
        
        if (newUsername == null || newUsername.trim().isEmpty()) {
            throw new RuntimeException("用户名不能为空");
        }
        
        if (newUsername.length() < 2 || newUsername.length() > 20) {
            throw new RuntimeException("用户名长度需要在2-20个字符之间");
        }
        
        if (!user.getUsername().equals(newUsername)) {
            if (userRepository.findByUsername(newUsername).isPresent()) {
                throw new RuntimeException("用户名已被使用");
            }
            user.setUsername(newUsername);
            userRepository.save(user);
        }
    }

    public Optional<User> findById(Long id) {
        return userRepository.findById(id);
    }
}
