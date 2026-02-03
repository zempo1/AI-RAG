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

    public Optional<User> findById(Long id) {
        return userRepository.findById(id);
    }
}
