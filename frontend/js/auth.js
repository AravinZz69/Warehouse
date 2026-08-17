document.addEventListener("DOMContentLoaded", () => {

    const errorMsg = document.getElementById("error-msg");
    const successMsg = document.getElementById("success-msg");

    const loginForm = document.getElementById("login-form");
    const signupForm = document.getElementById("signup-form");
    const forgotForm = document.getElementById("forgot-form");

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

    const getSb = () => {
        if (typeof window.getSupabaseClient === 'function') {
            return window.getSupabaseClient();
        }
        return window.supabaseClient || null;
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
                const sb = getSb();
                if (!sb) {
                    showError("Supabase configuration missing. Please update VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.");
                    return;
                }

                const { data, error } = await sb.auth.signInWithPassword({ email, password });

                if (error) {
                    showError(error.message);
                } else if (data && data.user) {
                    // Fetch user profile
                    const { data: profile } = await sb
                        .from("profiles")
                        .select("*")
                        .eq("id", data.user.id)
                        .single();

                    const isApproved = profile ? profile.is_approved : true;
                    if (!isApproved) {
                        await sb.auth.signOut();
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
                const sb = getSb();
                if (!sb) {
                    showError("Supabase configuration missing. Please update VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.");
                    return;
                }

                const { data, error } = await sb.auth.signUp({
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
                const sb = getSb();
                if (!sb) {
                    showError("Supabase configuration missing. Please update VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.");
                    return;
                }
                const { error } = await sb.auth.resetPasswordForEmail(email, {
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
