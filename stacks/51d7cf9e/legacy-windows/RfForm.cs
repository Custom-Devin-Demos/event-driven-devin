using System;
using System.Drawing;
using System.Media;
using System.Windows.Forms;
using EimRf.Rfc;

namespace EimRf
{
    public abstract class RfForm : Form
    {
        protected readonly Label MessageLabel;
        protected readonly Label HintLabel;
        protected readonly Label WaitLabel;
        protected readonly Label HeaderLabel;
        protected readonly ToolStripStatusLabel LastTxnStatus;
        private string _stepResult;

        protected RfForm(string screen, string hint)
        {
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(480, 640);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(40, 40);
            Text = "Tyson Foods EIM RF";
            KeyPreview = true;
            Font = new Font("Microsoft Sans Serif", 12F, FontStyle.Regular, GraphicsUnit.Point);
            if (Program.RdpSimEnabled)
            {
                FormBorderStyle = FormBorderStyle.None;
                TopMost = true;
                ClientSize = new Size(480, 640);
            }

            HeaderLabel = new Label
            {
                Dock = DockStyle.Top, Height = 34, TextAlign = ContentAlignment.MiddleLeft,
                BackColor = SystemColors.ActiveCaption, ForeColor = SystemColors.ActiveCaptionText,
                Font = new Font(Font, FontStyle.Bold), Padding = new Padding(8, 0, 0, 0),
                Text = "Tyson Foods EIM RF · " + screen
            };
            Controls.Add(HeaderLabel);
            var status = new StatusStrip { Dock = DockStyle.Bottom, SizingGrip = false };
            LastTxnStatus = new ToolStripStatusLabel("Last txn: 0.0s") { Spring = true, TextAlign = ContentAlignment.MiddleLeft };
            status.Items.Add(LastTxnStatus);
            status.Items.Add(new ToolStripStatusLabel("User: " + RfSession.User));
            status.Items.Add(new ToolStripStatusLabel("Plant: " + RfSession.Plant));
            status.Items.Add(new ToolStripStatusLabel("Dev: " + RfSession.Device));
            Controls.Add(status);

            HintLabel = new Label
            {
                Dock = DockStyle.Bottom, Height = 27, TextAlign = ContentAlignment.MiddleLeft,
                BackColor = SystemColors.Control, Padding = new Padding(8, 0, 0, 0), Text = hint
            };
            Controls.Add(HintLabel);
            MessageLabel = new Label
            {
                Dock = DockStyle.Bottom, Height = 28, TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(8, 0, 0, 0), ForeColor = Color.DarkGreen
            };
            Controls.Add(MessageLabel);
            WaitLabel = new Label
            {
                Visible = false, BorderStyle = BorderStyle.FixedSingle, BackColor = SystemColors.Control,
                Text = "Please wait…", TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font(Font.FontFamily, 18F, FontStyle.Bold), Size = new Size(300, 78),
                Location = new Point(90, 276)
            };
            Controls.Add(WaitLabel);
            KeyDown += FormKeyDown;
            RefreshStatus();
        }

        private void RefreshStatus()
        {
            foreach (Control control in Controls)
            {
                var strip = control as StatusStrip;
                if (strip != null && strip.Items.Count >= 4)
                {
                    strip.Items[1].Text = "User: " + RfSession.User;
                    strip.Items[2].Text = "Plant: " + RfSession.Plant;
                    strip.Items[3].Text = "Dev: " + RfSession.Device;
                }
            }
        }

        protected void UpdateSessionStatus()
        {
            RefreshStatus();
            Invalidate();
        }

        private void FormKeyDown(object sender, KeyEventArgs e)
        {
            if (OnFunctionKey(e.KeyCode))
            {
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
        }

        protected virtual bool OnFunctionKey(Keys key) { return false; }

        protected void RunStep(string workflow, string step, Action action)
        {
            RfcHelper.BeginStep(workflow, step);
            _stepResult = "OK";
            ShowWait();
            try { action(); }
            catch (RfcAbapException ex) { _stepResult = "E:" + ex.Key; ShowError(ex.Message); }
            catch (BapiReturnException ex) { _stepResult = "E:" + ex.Id + "/" + ex.Number; ShowError(ex.Message); }
            catch (WorkflowException ex) { _stepResult = "E:" + ex.Key; ShowError(ex.Message); }
            catch (RfcCommunicationException ex) { _stepResult = "E:RFC_COMMUNICATION_FAILURE"; ShowError("SAP connection failed: " + ex.Message); }
            catch (RfcBaseException ex) { _stepResult = "E:RFC_COMMUNICATION_FAILURE"; ShowError("SAP connection failed: " + ex.Message); }
            catch (Exception ex) { _stepResult = "E:APPLICATION_ERROR"; ShowError(ex.Message); }
            finally
            {
                long elapsed = RfcHelper.EndStep(_stepResult);
                LastTxnStatus.Text = "Last txn: " + (elapsed / 1000.0).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) + "s";
                HideWait();
            }
        }

        protected void ShowWait()
        {
            WaitLabel.Visible = true;
            WaitLabel.BringToFront();
            Cursor = Cursors.WaitCursor;
            WaitLabel.Refresh();
        }

        protected void HideWait()
        {
            WaitLabel.Visible = false;
            Cursor = Cursors.Default;
        }

        protected void ShowError(string message)
        {
            MessageLabel.ForeColor = Color.DarkRed;
            MessageLabel.Text = message;
            SystemSounds.Hand.Play();
        }

        protected void ShowSuccess(string message)
        {
            MessageLabel.ForeColor = Color.DarkGreen;
            MessageLabel.Text = message;
        }

        protected void ClearMessage() { MessageLabel.Text = ""; }

        protected static string ScanValue(TextBox textBox)
        {
            return textBox.Text.Trim().ToUpperInvariant();
        }

        protected static void FocusField(TextBox textBox)
        {
            textBox.Focus();
            textBox.SelectAll();
        }

        protected void CloseToMenu()
        {
            Close();
        }
    }
}
