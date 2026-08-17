document.addEventListener("DOMContentLoaded", () => {

    const errorMsg = document.getElementById("error-msg");
    const successMsg = document.getElementById("success-msg");

    const loginForm = document.getElementById("login-form");
    const signupForm = document.getElementById("signup-form");
    const signupVerifyForm = document.getElementById("signup-verify-form");
    const forgotForm = document.getElementById("forgot-form");
    const verifyForm = document.getElementById("verify-form");
    const resetForm = document.getElementById("reset-form");

    const showError = (msg) => {
        if (errorMsg) {
            errorMsg.textContent = msg;
            errorMsg.style.display = "block";
            if (successMsg) successMsg.style.display = "none";
        }
    };

    const showSuccess = (msg) => {
        if (successMsg) {
            successMsg.textContent = msg;
            successMsg.style.display = "block";
            if (errorMsg) errorMsg.style.display = "none";
        }
    };

    const hideMessages = () => {
        if (errorMsg) errorMsg.style.display = "none";
        if (successMsg) successMsg.style.display = "none";
    };

    const switchStep = (stepNum) => {
        document.querySelectorAll(".step").forEach(el => el.classList.remove("active"));
        document.querySelectorAll(".step-dot").forEach(el => el.classList.remove("active"));

        const stepEl = document.getElementById(`step-${stepNum}`);
        if (stepEl) stepEl.classList.add("active");

        for (let i = 1; i <= stepNum; i++) {
            const dotEl = document.getElementById(`dot-${i}`);
            if (dotEl) dotEl.classList.add("active");
        }
    };

    const getSupabase = () => {
        return window.supabaseClient || (window.supabase ? window.supabase.createClient(
            window.VITE_SUPABASE_URL || "https://syncstock-coreinventory.supabase.co",
            window.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bmNzdG9jay1jb3JlaW52ZW50b3J5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE2Nzg4ODAwMDAsImV4cCI6MjAwNDQ1NjAwMH0.sample_anon_key_for_development"
        ) : null);
    };

    // -- LOGIN LOGIC --
    if (loginForm) {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get("registered") === "1") {
            showSuccess("Account created successfully. Please log in.");
        }

        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            hideMessages();
            const btn = document.getElementById("login-btn");
            const originalText = btn.textContent;
            btn.innerHTML = "<div class='spinner' style='width:20px; height:20px; border-width:2px; margin: 0 auto;'></div>";
            btn.disabled = true;

            const email = document.getElementById("email").value;
            const password = document.getElementById("password").value;

            try {
                const supabase = getSupabase();
                if (!supabase) throw new Error("Supabase client not loaded");

                const { data, error } = await supabase.auth.signInWithPassword({ email, password });

                if (error) {
                    showError(error.message);
                } else if (data && data.user) {
                    // Fetch user profile
                    const { data: profile } = await supabase
                        .from("profiles")
                        .select("*")
                        .eq("id", data.user.id)
                        .single();

                    const isApproved = profile ? profile.is_approved : true;
                    if (!isApproved) {
                        await supabase.auth.signOut();
                        showError("Your account is pending manager approval.");
                        return;
                    }

                    const userName = profile?.name || data.user.user_metadata?.name || email.split("@")[0];
                    const userRole = profile?.role || data.user.user_metadata?.role || "staff";

                    localStorage.setItem("token", data.session.access_token);
                    localStorage.setItem("user_name", userName);
                    localStorage.setItem("user_role", userRole);
                    localStorage.setItem("user_id", data.user.id);

                    window.location.href = "dashboard.html";
                }
            } catch (err) {
                showError(err.message || "Network error. Could not connect to server.");
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        });
    }

    // -- SIGNUP LOGIC --
    if (signupForm) {
        signupForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            hideMessages();
            const btn = document.getElementById("signup-btn-step1");
            const originalText = btn.textContent;
            btn.innerHTML = "<div class='spinner' style='width:20px; height:20px; border-width:2px; margin: 0 auto;'></div>";
            btn.disabled = true;

            const name = document.getElementById("name").value;
            const email = document.getElementById("email").value;
            const password = document.getElementById("password").value;
            const role = document.getElementById("role").value;

            try {
                const supabase = getSupabase();
                if (!supabase) throw new Error("Supabase client not loaded");

                const { data, error } = await supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        data: {
                            name,
                            role,
                            is_approved: false
                        }
                    }
                });

                if (error) {
                    showError(error.message);
                } else {
                    showSuccess("Account registered! Pending manager approval.");
                    setTimeout(() => {
                        window.location.href = "login.html?registered=1";
                    }, 2500);
                }
            } catch (err) {
                showError(err.message || "Network error. Could not connect to server.");
            } finally {
                if (btn) {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }
            }
        });
    }

    // -- FORGOT PASSWORD LOGIC --
    if (forgotForm) {
        forgotForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            hideMessages();
            const btn = document.getElementById("btn-step-1");
            const originalText = btn.textContent;
            btn.textContent = "...";
            btn.disabled = true;

            const email = document.getElementById("email").value;

            try {
                const supabase = getSupabase();
                const { error } = await supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: window.location.origin + "/pages/login.html"
                });

                if (error) {
                    showError(error.message);
                } else {
                    showSuccess("Password reset instructions sent to your email.");
                }
            } catch (err) {
                showError("Network error.");
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        });
    }

});
